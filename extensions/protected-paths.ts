/**
 * Protected Paths Extension
 *
 * Blocks write, edit, and read operations to protected paths.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";

export default function (pi: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/", "/etc/", "/var/", "/usr/", "/bin/", "/sbin/"];
	const fileTools = ["write", "edit", "replace", "read", "ls", "grep", "find"];

	pi.on("tool_call", async (event, ctx) => {
		if (!fileTools.includes(event.toolName)) {
			return undefined;
		}

		// Try to extract a path from various tool parameters
		const input = event.input as Record<string, unknown>;
		const targetPath = (input.path || input.dir || input.include_pattern || "") as string;
		if (!targetPath) return undefined;

		const absoluteTarget = path.resolve(process.cwd(), targetPath);

		for (const protectedPath of protectedPaths) {
			if (protectedPath.startsWith("/")) {
				// Absolute protected path
				if (absoluteTarget === protectedPath || absoluteTarget.startsWith(protectedPath)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Blocked ${event.toolName} to system path: ${absoluteTarget}`, "error");
					}
					return { block: true, reason: `Path "${targetPath}" is a protected system path` };
				}
			} else {
				// Relative protected path (check if it exists anywhere in the target string or as a component)
				if (absoluteTarget.includes(`/${protectedPath}`) || absoluteTarget.endsWith(`/${protectedPath.replace(/\/$/, "")}`)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Blocked ${event.toolName} to sensitive path: ${targetPath}`, "error");
					}
					return { block: true, reason: `Path "${targetPath}" contains protected component "${protectedPath}"` };
				}
			}
		}

		return undefined;
	});
}
