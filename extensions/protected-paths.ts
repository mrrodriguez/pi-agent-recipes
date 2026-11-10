/**
 * Protected Paths Extension
 *
 * Zero-config guardrails for built-in file tools (`read`, `ls`, `grep`, `find`,
 * `write`, `edit`, `replace`). Blocks reads and writes to common credential
 * stores, secret/key files at any directory depth, VCS/dependency internals,
 * system directories, and writes to Pi's live host runtime configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "os";
import * as path from "path";

const FILE_TOOLS = new Set(["write", "edit", "replace", "read", "ls", "grep", "find"]);
const MUTATING_FILE_TOOLS = new Set(["write", "edit", "replace"]);

const PROTECTED_COMPONENTS = [
	".git/",
	"node_modules/",
	".ssh/",
	".aws/",
	".gnupg/",
	".pi/agent/auth.json",
	"Library/Keychains/",
	"/etc/",
	"/var/",
	"/usr/",
	"/bin/",
	"/sbin/",
];

const WRITE_PROTECTED_HOST_PATHS = [
	".pi/agent/models.json",
	".pi/agent/settings.json",
	".pi/agent/sandbox.json",
	".pi/agent/mcp.json",
	".pi/agent/extensions/",
];

function normalizeInputPath(raw: string): string {
	const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
	if (stripped === "~") return os.homedir();
	if (stripped.startsWith("~/")) return path.join(os.homedir(), stripped.slice(2));
	return stripped;
}

function isProtectedSecretBasename(base: string): boolean {
	const lower = base.toLowerCase();
	return (
		lower === ".env" ||
		lower.startsWith(".env.") ||
		lower.endsWith(".pem") ||
		lower.endsWith(".key")
	);
}

function matchesComponent(absoluteTarget: string, protectedPath: string): boolean {
	if (protectedPath.startsWith("/")) {
		const trimmed = protectedPath.replace(/\/$/, "");
		return absoluteTarget === trimmed || absoluteTarget.startsWith(protectedPath);
	}
	const trimmed = protectedPath.replace(/\/$/, "");
	return (
		absoluteTarget.includes(`/${protectedPath}`) ||
		absoluteTarget.endsWith(`/${trimmed}`)
	);
}

export default function (pi: ExtensionAPI) {
	const homeAgentPrefix = path.join(os.homedir(), ".pi", "agent");

	pi.on("tool_call", async (event, ctx) => {
		if (!FILE_TOOLS.has(event.toolName)) {
			return undefined;
		}

		const input = event.input as Record<string, unknown>;
		const targetPath = (input.path || input.dir || "") as string;
		if (!targetPath) return undefined;

		const absoluteTarget = path.resolve(ctx.cwd, normalizeInputPath(targetPath));
		const base = path.basename(absoluteTarget);

		if (isProtectedSecretBasename(base)) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked ${event.toolName} to secret/key file: ${targetPath}`, "error");
			}
			return {
				block: true,
				reason: `Path "${targetPath}" matches protected secret/key filename "${base}"`,
			};
		}

		for (const protectedPath of PROTECTED_COMPONENTS) {
			if (matchesComponent(absoluteTarget, protectedPath)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} to protected path: ${targetPath}`, "error");
				}
				return {
					block: true,
					reason: `Path "${targetPath}" matches protected path "${protectedPath}"`,
				};
			}
		}

		if (MUTATING_FILE_TOOLS.has(event.toolName) && absoluteTarget.startsWith(`${homeAgentPrefix}/`)) {
			for (const hostPath of WRITE_PROTECTED_HOST_PATHS) {
				if (matchesComponent(absoluteTarget, hostPath)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Blocked ${event.toolName} to live Pi config: ${targetPath}`, "error");
					}
					return {
						block: true,
						reason: `Writes to live host configuration "${hostPath}" are blocked`,
					};
				}
			}
		}

		return undefined;
	});
}
