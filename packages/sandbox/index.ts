/**
 * Sandbox Extension - Unified OS-level Sandboxing
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on shell commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * STRATEGY: Unified Mutation
 * This extension uses Pi's `tool_call` event to intercept and mutate tool
 * inputs BEFORE they execute. By wrapping the command string in a sandbox
 * container (e.g., `bwrap` or `sandbox-exec`), we ensure that ANY tool
 * executing shell code respects the global policy, including built-in `bash`
 * and third-party tools like `ctx_execute`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	getAgentDir,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

/** Input schema for context-mode execution tools */
interface ContextModeInput extends Record<string, unknown> {
	code: string;
	language?: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

// ── Extension Logic ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let toolCallRegistered = false;

	// ── Registration ──────────────────────────────────────────────────────────

	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for shell commands",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			if (!sandboxEnabled) {
				ctx.ui.notify("Sandbox is disabled", "info");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const lines = [
				"Sandbox Configuration (Unified Mutation):",
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				`  Local Binding: ${config.network?.allowLocalBinding ? "Enabled" : "Disabled"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Mutation Interceptor ──────────────────────────────────────────────────

	/**
	 * Transparently wraps shell commands in an OS sandbox container.
	 * This happens BEFORE the tool executes, making it tool-agnostic.
	 */
	async function wrapShellInSandbox(event: ToolCallEvent) {
		if (!sandboxEnabled || !sandboxInitialized) return;

		// Handle built-in bash
		if (isToolCallEventType("bash", event)) {
			event.input.command = await SandboxManager.wrapWithSandbox(event.input.command);
		}

		// Handle context-mode shell execution
		const isCtx =
			isToolCallEventType<"ctx_execute", ContextModeInput>("ctx_execute", event) ||
			isToolCallEventType<"ctx_execute_file", ContextModeInput>("ctx_execute_file", event);

		if (isCtx && event.input.language === "shell") {
			event.input.code = await SandboxManager.wrapWithSandbox(event.input.code);
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Sandbox initialized (Unified Mutation Mode)", "info");

			// Register tool_call mutation handler LATE (during session_start)
			// to ensure it runs AFTER other interceptors registered during factory load.
			// We use a flag to ensure idempotent registration, preventing redundant
			// nesting if session_start fires multiple times for this instance.
			if (!toolCallRegistered) {
				pi.on("tool_call", async (event) => {
					await wrapShellInSandbox(event);
				});
				toolCallRegistered = true;
			}
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});
}
