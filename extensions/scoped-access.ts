/**
 * Scoped Access Extension
 *
 * Restricts file-related tools to the session's launch directory (CWD) by default.
 * Prompts the user when a tool attempts to access a path outside this scope and
 * bridges approved write scopes to the OS sandbox via `pi.events`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

type ScopeMode = "read" | "write";

type AccessDecision =
	| { kind: "allow-session-write"; scope: string }
	| { kind: "allow-session-read"; scope: string }
	| { kind: "allow-write-once"; scope: string }
	| { kind: "allow-read-once"; scope: string }
	| { kind: "deny"; reason: string };

export default function (pi: ExtensionAPI) {
	const launchDir = process.cwd();
	const readAllowedPaths = new Set<string>([launchDir]);
	const writeAllowedPaths = new Set<string>([launchDir]);
	const fileTools = ["write", "edit", "replace", "read", "ls", "grep", "find"];
	const mutatingFileTools = new Set(["write", "edit", "replace"]);
	const systemRoots = [
		"Applications",
		"Library",
		"System",
		"Users",
		"Volumes",
		"bin",
		"cores",
		"dev",
		"etc",
		"home",
		"opt",
		"private",
		"sbin",
		"tmp",
		"usr",
		"var",
	];

	// --- Helper Functions ---

	const expandTilde = (raw: string) => {
		const p = raw.startsWith("@") ? raw.slice(1) : raw;
		if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
		return p === "~" ? os.homedir() : p;
	};

	const getTargetScope = (targetPath: string) => {
		const absoluteTarget = path.resolve(launchDir, expandTilde(targetPath));
		try {
			return fs.statSync(absoluteTarget).isDirectory()
				? absoluteTarget
				: path.dirname(absoluteTarget);
		} catch {
			return path.dirname(absoluteTarget);
		}
	};

	const isPathUnderAny = (
		targetPath: string,
		scopes: ReadonlySet<string>,
	): boolean => {
		const absoluteTarget = path.resolve(launchDir, expandTilde(targetPath));
		return Array.from(scopes).some((allowed) => {
			const relative = path.relative(allowed, absoluteTarget);
			return !relative.startsWith("..") && !path.isAbsolute(relative);
		});
	};

	const isPathInReadScope = (targetPath: string) =>
		isPathUnderAny(targetPath, readAllowedPaths);

	const isPathInWriteScope = (targetPath: string) =>
		isPathUnderAny(targetPath, writeAllowedPaths);

	const isLikelyFileSystemPath = (p: string) => {
		if (p.startsWith("//")) return false;
		if (
			p.includes("..") ||
			p.startsWith("~") ||
			p.startsWith("./") ||
			p.startsWith("../")
		)
			return true;
		if (!p.startsWith("/")) return false;

		const parts = p.split("/").filter(Boolean);
		return (
			systemRoots.includes(parts[0]) || // /Users, /etc, etc.
			parts.length > 1 || // /foo/bar
			p.includes(".") || // /file.txt
			fs.existsSync(p) // Real file on disk
		);
	};

	const extractSuspectPathsFromCommand = (command: string): string[] => {
		const pathRegex = /(?:^|[\s"'=>:])((?:\/|~|\.\.?\/)[a-zA-Z0-9._/-]+)/g;
		const matches = Array.from(command.matchAll(pathRegex)).map((m) => m[1]);

		return matches.filter((p) => {
			if (!isLikelyFileSystemPath(p)) return false;
			// Ignore standard non-sensitive binary paths
			if (
				p.startsWith("/usr/bin") ||
				p.startsWith("/bin") ||
				p.startsWith("/sbin") ||
				p.startsWith("/dev")
			)
				return false;
			return !isPathInReadScope(p);
		});
	};

	const grantDirectoryScope = (
		targetScope: string,
		mode: ScopeMode,
		ctx: ExtensionContext,
	) => {
		readAllowedPaths.add(targetScope);
		if (mode === "write") {
			writeAllowedPaths.add(targetScope);
			pi.events.emit("sandbox:allow-write", { path: targetScope });
			ctx.ui.notify(`Added to scope (read-write): ${targetScope}`, "info");
		} else {
			if (targetScope !== launchDir && writeAllowedPaths.delete(targetScope)) {
				pi.events.emit("sandbox:revoke-write", { path: targetScope });
			}
			ctx.ui.notify(`Added to scope (read-only): ${targetScope}`, "info");
		}
	};

	const promptForScopeAccess = async (
		ctx: ExtensionContext,
		message: string,
		choices: string[],
		targetScope: string,
	): Promise<AccessDecision> => {
		if (!ctx.hasUI) {
			return {
				kind: "deny",
				reason: `Path "${targetScope}" is outside session scope and no UI for confirmation.`,
			};
		}

		const choice = await ctx.ui.select(message, choices);
		if (!choice) {
			return { kind: "deny", reason: "Access denied by user (out of scope)" };
		}

		const lower = choice.toLowerCase();

		if (lower.includes("allow directory read-write")) {
			grantDirectoryScope(targetScope, "write", ctx);
			return { kind: "allow-session-write", scope: targetScope };
		}

		if (lower.includes("allow directory read-only")) {
			grantDirectoryScope(targetScope, "read", ctx);
			return { kind: "allow-session-read", scope: targetScope };
		}

		if (lower.includes("allow write")) {
			return { kind: "allow-write-once", scope: targetScope };
		}

		if (lower.startsWith("yes")) {
			return { kind: "allow-read-once", scope: targetScope };
		}

		return { kind: "deny", reason: "Access denied by user (out of scope)" };
	};

	// --- Event Handlers ---

	pi.on("tool_call", async (event, ctx) => {
		// 1. Handle File Tools
		if (fileTools.includes(event.toolName)) {
			const input = event.input as Record<string, unknown>;
			const targetPath = (input.path ||
				input.dir ||
				input.include_pattern ||
				"") as string;

			if (
				!targetPath &&
				(event.toolName === "grep" || event.toolName === "find")
			)
				return undefined;

			const isMutating = mutatingFileTools.has(event.toolName);
			const inScope = isMutating
				? isPathInWriteScope(targetPath)
				: isPathInReadScope(targetPath);

			if (!inScope) {
				const targetScope = getTargetScope(targetPath);
				const choices = isMutating
					? [
							"No",
							"Yes (once, allow write)",
							"Yes (allow directory read-write for session)",
						]
					: [
							"No",
							"Yes (once)",
							"Yes (allow directory read-only for session)",
							"Yes (allow directory read-write for session)",
						];
				const scopeLabel =
					isMutating && isPathInReadScope(targetPath)
						? "Write access to read-only session scope"
						: "Access outside session scope";

				const decision = await promptForScopeAccess(
					ctx,
					`⚠️ ${scopeLabel}:\n\n  Tool: ${event.toolName}\n  Path: ${targetPath}\n\nAllow?`,
					choices,
					targetScope,
				);
				if (decision.kind === "deny") {
					return { block: true, reason: decision.reason };
				}
				if (decision.kind === "allow-write-once") {
					pi.events.emit("sandbox:allow-write-once", {
						toolCallId: event.toolCallId,
						paths: [decision.scope],
					});
				}
			}
		}

		// 2. Handle Bash
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const suspectPaths = extractSuspectPathsFromCommand(command);

			// Deduplicate out-of-scope references by resolved target directory so
			// commands mentioning multiple files in the same directory prompt once.
			const pathsByScope = new Map<string, string[]>();
			for (const p of suspectPaths) {
				if (isPathInReadScope(p)) continue;
				const scope = getTargetScope(p);
				const existing = pathsByScope.get(scope);
				if (existing) {
					if (!existing.includes(p)) existing.push(p);
				} else {
					pathsByScope.set(scope, [p]);
				}
			}

			const approvedOnceScopes: string[] = [];

			for (const [scope, matchedPaths] of pathsByScope) {
				if (isPathInReadScope(scope)) continue;

				const decision = await promptForScopeAccess(
					ctx,
					`⚠️ Bash command references path outside scope:\n\n  Command: ${command}\n  Scope: ${scope}\n  Matched: ${matchedPaths.join(", ")}\n\nAllow?`,
					[
						"No",
						"Yes (once, read-only)",
						"Yes (once, allow write)",
						"Yes (allow directory read-only for session)",
						"Yes (allow directory read-write for session)",
					],
					scope,
				);
				if (decision.kind === "deny") {
					return { block: true, reason: decision.reason };
				}
				if (decision.kind === "allow-write-once") {
					approvedOnceScopes.push(decision.scope);
				}
			}

			if (approvedOnceScopes.length > 0) {
				pi.events.emit("sandbox:allow-write-once", {
					toolCallId: event.toolCallId,
					paths: approvedOnceScopes,
				});
			}
		}

		return undefined;
	});

	// --- Commands ---

	pi.registerCommand("scope", {
		description: "Manage allowed directories for the current session",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subCommand = (parts[0] ?? "").toLowerCase();
			const rest = parts.slice(1);

			if ((subCommand === "add" || subCommand === "add-write") && rest.length > 0) {
				const isReadFlag = rest[0] === "--read" || rest[0] === "-r";
				const target = (isReadFlag ? rest.slice(1) : rest).join(" ");
				if (!target) {
					ctx.ui.notify(
						"Usage: /scope [add [--read] <path> | add-read <path> | remove <path> | list]",
						"warning",
					);
					return;
				}
				const targetScope = getTargetScope(target);
				if (isReadFlag && targetScope === launchDir) {
					ctx.ui.notify(
						`Launch directory is always read-write: ${launchDir}`,
						"warning",
					);
					return;
				}
				grantDirectoryScope(targetScope, isReadFlag ? "read" : "write", ctx);
			} else if (subCommand === "add-read" && rest.length > 0) {
				const target = rest.join(" ");
				const targetScope = getTargetScope(target);
				if (targetScope === launchDir) {
					ctx.ui.notify(
						`Launch directory is always read-write: ${launchDir}`,
						"warning",
					);
					return;
				}
				grantDirectoryScope(targetScope, "read", ctx);
			} else if ((subCommand === "remove" || subCommand === "rm") && rest.length > 0) {
				const target = rest.join(" ");
				const resolvedTarget = path.resolve(launchDir, expandTilde(target));
				const targetScope = readAllowedPaths.has(resolvedTarget)
					? resolvedTarget
					: getTargetScope(target);

				if (targetScope === launchDir) {
					ctx.ui.notify(
						`Cannot remove launch directory from scope: ${launchDir}`,
						"warning",
					);
					return;
				}
				if (!readAllowedPaths.has(targetScope)) {
					ctx.ui.notify(
						`Path is not in active scope: ${targetScope}`,
						"warning",
					);
					return;
				}

				readAllowedPaths.delete(targetScope);
				if (writeAllowedPaths.delete(targetScope)) {
					pi.events.emit("sandbox:revoke-write", { path: targetScope });
				}
				ctx.ui.notify(`Removed from scope: ${targetScope}`, "info");
			} else if (subCommand === "list") {
				const list = Array.from(readAllowedPaths)
					.sort()
					.map((p) => {
						const mode = writeAllowedPaths.has(p) ? "read-write" : "read-only";
						return `${p} (${mode})`;
					})
					.join("\n  - ");
				ctx.ui.notify(`Allowed scopes:\n  - ${list}`, "info");
			} else {
				ctx.ui.notify(
					"Usage: /scope [add [--read] <path> | add-read <path> | remove <path> | list]",
					"warning",
				);
			}
		},
	});
}
