/**
 * Sandbox Extension - Unified OS-level & Tool-level Policy Enforcement
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on shell commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux), and enforces the same `sandbox.json` filesystem policy
 * (`denyRead`, `denyWrite`, `allowWrite`) on built-in non-shell file tools.
 *
 * STRATEGY: Unified Mutation & Policy Gate
 * This extension uses Pi's `tool_call` event to validate built-in file tool
 * paths against `sandbox.json` and to wrap `bash` command strings in an OS
 * sandbox container BEFORE they execute, without replacing built-in tools.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	SandboxManager,
	type SandboxRuntimeConfig,
	getDefaultWritePaths,
} from "@anthropic-ai/sandbox-runtime";
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

// ── Configuration ────────────────────────────────────────────────────────────

const FILE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"ls",
	"grep",
	"find",
	"write",
	"edit",
	"replace",
]);

const MUTATING_FILE_TOOLS: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"replace",
]);

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
		denyRead: [
			"~/.ssh",
			"~/.aws",
			"~/.gnupg",
			"~/.pi/agent/auth.json",
			"~/Library/Keychains",
		],
		allowWrite: [".", "/tmp"],
		denyWrite: [
			".env",
			"/**/.env",
			"/**/.env.*",
			"/**/*.pem",
			"/**/*.key",
			"~/.pi/agent/auth.json",
			"~/.pi/agent/models.json",
			"~/.pi/agent/settings.json",
			"~/.pi/agent/sandbox.json",
			"~/.pi/agent/mcp.json",
			"~/.pi/agent/extensions",
		],
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

	if (overrides.ignoreViolations) {
		result.ignoreViolations = overrides.ignoreViolations;
	}
	if (overrides.enableWeakerNestedSandbox !== undefined) {
		result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
	}

	return result;
}

function expandInputPath(raw: string): string {
	const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
	if (stripped === "~") return homedir();
	if (stripped.startsWith("~/")) return join(homedir(), stripped.slice(2));
	return stripped;
}

function resolveRealPathWithMissingLeaf(absPath: string): string {
	try {
		return realpathSync(absPath);
	} catch {
		const parent = dirname(absPath);
		if (parent === absPath) return absPath;
		return join(resolveRealPathWithMissingLeaf(parent), basename(absPath));
	}
}

function containsGlobChars(pattern: string): boolean {
	return (
		pattern.includes("*") ||
		pattern.includes("?") ||
		pattern.includes("[") ||
		pattern.includes("]")
	);
}

function globToRegExp(globPattern: string): RegExp {
	const source =
		"^" +
		globPattern
			.replace(/[.^$+{}()|\\]/g, "\\$&")
			.replace(/\[([^\]]*?)$/g, "\\[$1")
			.replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
			.replace(/\*\*/g, "__GLOBSTAR__")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
			.replace(/__GLOBSTAR__/g, ".*") +
		"$";
	return new RegExp(source, process.platform === "darwin" ? "i" : "");
}

function matchesSandboxPattern(
	resolvedTarget: string,
	rawPattern: string,
	cwd: string,
): boolean {
	const stripped = rawPattern.replace(/\/\*\*$/, "") || "/";
	const expanded = expandInputPath(stripped);
	const absPattern = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

	if (containsGlobChars(absPattern)) {
		const staticPrefix = absPattern.split(/[*?[\]]/)[0] ?? "";
		let normalizedGlob = absPattern;
		if (staticPrefix && staticPrefix !== "/") {
			const baseDir = staticPrefix.endsWith("/")
				? staticPrefix.slice(0, -1)
				: dirname(staticPrefix);
			const resolvedBase = resolveRealPathWithMissingLeaf(baseDir);
			normalizedGlob = resolvedBase + absPattern.slice(baseDir.length);
		}
		return globToRegExp(normalizedGlob).test(resolvedTarget);
	}

	const normalizedLiteral = resolveRealPathWithMissingLeaf(absPattern);
	if (normalizedLiteral === "/") return true;
	return (
		resolvedTarget === normalizedLiteral ||
		resolvedTarget.startsWith(`${normalizedLiteral}/`)
	);
}

function matchesAnyPattern(
	resolvedTarget: string,
	patterns: readonly string[],
	cwd: string,
): string | undefined {
	return patterns.find((pattern) => matchesSandboxPattern(resolvedTarget, pattern, cwd));
}

// Validate untrusted EventBus payloads at the inter-extension boundary.
function isPathPayload(data: unknown): data is { path: string } {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as Record<string, unknown>).path === "string"
	);
}

function isAllowWriteOncePayload(
	data: unknown,
): data is { toolCallId: string; paths: string[] } {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return (
		typeof record.toolCallId === "string" &&
		Array.isArray(record.paths) &&
		record.paths.every((p): p is string => typeof p === "string")
	);
}

function mergeAllowWrite(
	baseAllowWrite: readonly string[],
	dynamicPaths: ReadonlySet<string>,
	extraPaths: readonly string[] = [],
): string[] {
	return Array.from(new Set([...baseAllowWrite, ...dynamicPaths, ...extraPaths]));
}

/**
 * Expand bare basename patterns (e.g. ".env", ".env.*", "*.pem", "*.key") and
 * root-globstar patterns so @anthropic-ai/sandbox-runtime enforces them at
 * every directory depth rather than only at the workspace root.
 *
 * Why: normalizePathForSandbox() in @anthropic-ai/sandbox-runtime resolves any
 * pattern without a leading "/" or "~" via path.resolve(cwd, pattern). A bare
 * ".env" or "*.pem" therefore compiles to "/cwd/.env" or "^/cwd/[^/]*\\.pem$",
 * which blocks writes at the workspace root but permits "any/subdir/.env".
 * Emitting all three forms covers:
 * - "<name>"       -> literal/shallow cwd path
 * - "**" + "/..."  -> cwd subtree at any depth (and Linux bwrap expandGlobPattern)
 * - "/**" + "/..." -> macOS Seatbelt regex at any depth across cwd, /tmp, and
 *                     dynamically /scope-granted repositories.
 */
function expandDenyWritePatterns(patterns: readonly string[]): string[] {
	const expanded = new Set<string>();
	for (const pattern of patterns) {
		expanded.add(pattern);
		if (!pattern.includes("/") && pattern !== "." && pattern !== "..") {
			expanded.add(`**/${pattern}`);
			expanded.add(`/**/${pattern}`);
		} else if (pattern.startsWith("/**/")) {
			const tail = pattern.slice(4);
			if (tail && !tail.includes("/")) {
				expanded.add(tail);
				expanded.add(`**/${tail}`);
			}
		}
	}
	return Array.from(expanded);
}

function toRuntimeConfig(
	config: SandboxConfig,
	allowWrite: string[],
): SandboxRuntimeConfig {
	const denyWrite = expandDenyWritePatterns(config.filesystem?.denyWrite ?? []);
	return {
		network: config.network,
		filesystem: {
			...config.filesystem,
			allowWrite,
			denyWrite,
		},
		ignoreViolations: config.ignoreViolations,
		enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
	};
}

function updateStatusBar(
	ctx: ExtensionContext,
	config: SandboxConfig,
	dynamicCount: number,
) {
	const networkCount = config.network?.allowedDomains?.length ?? 0;
	const writeCount = config.filesystem?.allowWrite?.length ?? 0;
	const scopedSuffix = dynamicCount > 0 ? ` (+${dynamicCount} scoped)` : "";
	ctx.ui.setStatus(
		"sandbox",
		ctx.ui.theme.fg(
			"accent",
			`🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths${scopedSuffix}`,
		),
	);
}

// ── Extension Logic ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let toolCallRegistered = false;
	let activeConfig: SandboxConfig | undefined;
	let activeCtx: ExtensionContext | undefined;

	const dynamicAllowWrite = new Set<string>();
	const oneShotAllowWrite = new Map<string, string[]>();

	function syncDynamicWriteConfig() {
		if (!sandboxEnabled || !sandboxInitialized || !activeConfig) return;
		const baseAllowWrite = activeConfig.filesystem?.allowWrite ?? [];
		const allowWrite = mergeAllowWrite(baseAllowWrite, dynamicAllowWrite);
		SandboxManager.updateConfig(toRuntimeConfig(activeConfig, allowWrite));
		if (activeCtx) {
			updateStatusBar(activeCtx, activeConfig, dynamicAllowWrite.size);
		}
	}

	pi.events.on("sandbox:allow-write", (data) => {
		if (!isPathPayload(data)) return;
		const prevSize = dynamicAllowWrite.size;
		dynamicAllowWrite.add(data.path);
		if (dynamicAllowWrite.size !== prevSize) {
			syncDynamicWriteConfig();
		}
	});

	pi.events.on("sandbox:revoke-write", (data) => {
		if (!isPathPayload(data)) return;
		if (dynamicAllowWrite.delete(data.path)) {
			syncDynamicWriteConfig();
		}
	});

	pi.events.on("sandbox:allow-write-once", (data) => {
		if (!isAllowWriteOncePayload(data)) return;
		if (data.paths.length > 0) {
			oneShotAllowWrite.set(data.toolCallId, data.paths);
		}
	});

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

			const config = activeConfig ?? loadConfig(ctx.cwd);
			const dynamicPaths = Array.from(dynamicAllowWrite).sort();
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
				`  Allow Write (base): ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Allow Write (session /scope): ${dynamicPaths.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Policy & Mutation Interceptor ─────────────────────────────────────────

	function checkFileToolPolicy(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): { block: true; reason: string } | undefined {
		if (!sandboxEnabled || !activeConfig || !FILE_TOOLS.has(event.toolName)) {
			return undefined;
		}

		const input = event.input as Record<string, unknown>;
		const rawPath = ((input.path || input.dir || "") as string) || ".";
		const resolvedTarget = resolveRealPathWithMissingLeaf(
			resolve(ctx.cwd, expandInputPath(rawPath)),
		);

		const denyRead = activeConfig.filesystem?.denyRead ?? [];
		const allowRead = activeConfig.filesystem?.allowRead ?? [];
		const matchedDenyRead = matchesAnyPattern(resolvedTarget, denyRead, ctx.cwd);
		if (
			matchedDenyRead &&
			!matchesAnyPattern(resolvedTarget, allowRead, ctx.cwd)
		) {
			return {
				block: true,
				reason: `Sandbox denyRead rule "${matchedDenyRead}" blocked ${event.toolName} on "${rawPath}"`,
			};
		}

		if (MUTATING_FILE_TOOLS.has(event.toolName)) {
			const oneShotPaths = oneShotAllowWrite.get(event.toolCallId) ?? [];
			oneShotAllowWrite.delete(event.toolCallId);

			const denyWrite = expandDenyWritePatterns(
				activeConfig.filesystem?.denyWrite ?? [],
			);
			const matchedDenyWrite = matchesAnyPattern(resolvedTarget, denyWrite, ctx.cwd);
			if (matchedDenyWrite) {
				return {
					block: true,
					reason: `Sandbox denyWrite rule "${matchedDenyWrite}" blocked ${event.toolName} on "${rawPath}"`,
				};
			}

			const baseAllowWrite = activeConfig.filesystem?.allowWrite ?? [];
			const effectiveAllowWrite = mergeAllowWrite(baseAllowWrite, dynamicAllowWrite, [
				...oneShotPaths,
				...getDefaultWritePaths(),
			]);
			if (!matchesAnyPattern(resolvedTarget, effectiveAllowWrite, ctx.cwd)) {
				return {
					block: true,
					reason: `Sandbox allowWrite policy blocked ${event.toolName} outside writable scope: "${rawPath}"`,
				};
			}
		}

		return undefined;
	}

	/**
	 * Transparently wraps shell commands in an OS sandbox container.
	 * This happens BEFORE the tool executes, making it tool-agnostic.
	 */
	async function wrapShellInSandbox(event: ToolCallEvent) {
		if (!sandboxEnabled || !sandboxInitialized || !activeConfig) return;

		if (isToolCallEventType("bash", event)) {
			const oneShotPaths = oneShotAllowWrite.get(event.toolCallId);
			oneShotAllowWrite.delete(event.toolCallId);

			if (oneShotPaths && oneShotPaths.length > 0) {
				const baseAllowWrite = activeConfig.filesystem?.allowWrite ?? [];
				const allowWrite = mergeAllowWrite(
					baseAllowWrite,
					dynamicAllowWrite,
					oneShotPaths,
				);
				const denyWrite = expandDenyWritePatterns(
					activeConfig.filesystem?.denyWrite ?? [],
				);
				event.input.command = await SandboxManager.wrapWithSandbox(
					event.input.command,
					undefined,
					{
						filesystem: {
							...activeConfig.filesystem,
							allowWrite,
							denyWrite,
						},
					},
				);
				return;
			}

			event.input.command = await SandboxManager.wrapWithSandbox(event.input.command);
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		activeCtx = ctx;
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);
		activeConfig = config;

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
			const baseAllowWrite = config.filesystem?.allowWrite ?? [];
			const runtimeConfig = toRuntimeConfig(
				config,
				mergeAllowWrite(baseAllowWrite, dynamicAllowWrite),
			);

			if (sandboxInitialized) {
				SandboxManager.updateConfig(runtimeConfig);
			} else {
				await SandboxManager.initialize(runtimeConfig);
			}

			sandboxEnabled = true;
			sandboxInitialized = true;

			updateStatusBar(ctx, config, dynamicAllowWrite.size);
			ctx.ui.notify("Sandbox initialized (Unified Mutation Mode)", "info");

			// Register tool_call mutation handler LATE (during session_start)
			// to ensure it runs AFTER other interceptors registered during factory load.
			// We use a flag to ensure idempotent registration, preventing redundant
			// nesting if session_start fires multiple times for this instance.
			if (!toolCallRegistered) {
				pi.on("tool_call", async (event, callCtx) => {
					const blocked = checkFileToolPolicy(event, callCtx);
					if (blocked) return blocked;
					await wrapShellInSandbox(event);
					return undefined;
				});
				pi.on("tool_execution_end", (event) => {
					oneShotAllowWrite.delete(event.toolCallId);
				});
				toolCallRegistered = true;
			}
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		oneShotAllowWrite.clear();
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
				sandboxInitialized = false;
			} catch {
				// Ignore cleanup errors
			}
		}
	});
}
