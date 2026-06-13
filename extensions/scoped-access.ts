/**
 * Scoped Access Extension
 *
 * Restricts file-related tools to the session's launch directory (CWD) by default.
 * Prompts the user when a tool attempts to access a path outside this scope.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export default function (pi: ExtensionAPI) {
	const launchDir = process.cwd();
	const allowedPaths = new Set<string>([launchDir]);
	const fileTools = ["write", "edit", "replace", "read", "ls", "grep", "find"];
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

	const expandTilde = (p: string) => {
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

	const isPathInScope = (targetPath: string) => {
		const absoluteTarget = path.resolve(launchDir, expandTilde(targetPath));
		return Array.from(allowedPaths).some((allowed) => {
			const relative = path.relative(allowed, absoluteTarget);
			return !relative.startsWith("..") && !path.isAbsolute(relative);
		});
	};

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
			return !isPathInScope(p);
		});
	};

	const promptForAccess = async (
		ctx: any,
		message: string,
		choices: string[],
		targetPath: string,
	) => {
		if (!ctx.hasUI)
			return {
				block: true,
				reason: `Path "${targetPath}" is outside session scope and no UI for confirmation.`,
			};

		const choice = await ctx.ui.select(message, choices);

		if (choice.toLowerCase().includes("allow directory")) {
			const targetScope = getTargetScope(targetPath);
			allowedPaths.add(targetScope);
			ctx.ui.notify(`Added to scope: ${targetScope}`, "info");
			return undefined;
		}

		if (choice.toLowerCase().startsWith("yes")) {
			return undefined;
		}

		return { block: true, reason: "Access denied by user (out of scope)" };
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

			if (!isPathInScope(targetPath)) {
				return promptForAccess(
					ctx,
					`⚠️ Access outside session scope:\n\n  Tool: ${event.toolName}\n  Path: ${targetPath}\n\nAllow?`,
					["No", "Yes (once)", "Yes (allow directory for session)"],
					targetPath,
				);
			}
		}

		// 2. Handle Bash
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const suspectPaths = extractSuspectPathsFromCommand(command);

			for (const p of suspectPaths) {
				const result = await promptForAccess(
					ctx,
					`⚠️ Bash command references path outside scope:\n\n  Command: ${command}\n  Suspect Path: ${p}\n\nAllow?`,
					["No", "Yes", "Yes, and allow directory"],
					p,
				);
				if (result?.block) return result;
			}
		}

		return undefined;
	});

	// --- Commands ---

	pi.registerCommand("scope", {
		description: "Manage allowed directories for the current session",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subCommand = parts[0].toLowerCase();
			const target = parts.slice(1).join(" ");

			if (subCommand === "add" && target) {
				const targetScope = getTargetScope(target);
				allowedPaths.add(targetScope);
				ctx.ui.notify(`Added to scope: ${targetScope}`, "info");
			} else if (subCommand === "list") {
				const list = Array.from(allowedPaths).sort().join("\n  - ");
				ctx.ui.notify(`Allowed scopes:\n  - ${list}`, "info");
			} else {
				ctx.ui.notify("Usage: /scope [add <path> | list]", "warning");
			}
		},
	});
}
