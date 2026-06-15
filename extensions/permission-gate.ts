/**
 * Permission Gate Extension (Enhanced & Type-Safe)
 *
 * Provides a "Soft" safety layer with confirmation prompts for destructive
 * operations. Complements "Hard" OS-level sandboxing.
 *
 * This version is "context-mode aware": it monitors both standard bash
 * and context-mode execution tools (ctx_execute, ctx_execute_file).
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

interface ContextModeInput extends Record<string, unknown> {
	code: string;
	language?: string;
}

interface GenericFileInput extends Record<string, unknown> {
	path: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DANGEROUS_BASH_PATTERNS = [
	/\brm\s+(-[rfR]+|--recursive)/i, // Catch -r, -rf, -R, -rfR
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
];

const FILE_TOOLS = ["write", "edit", "replace"] as const;

// ── Extension Logic ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let trustEdits = false;

	// ── Utilities ─────────────────────────────────────────────────────────────

	/** Extracts a command string from various shell-like tools */
	function getShellCommand(event: ToolCallEvent): { command: string; tool: string } | null {
		if (isToolCallEventType("bash", event)) {
			return { command: event.input.command, tool: "bash" };
		}
		if (isToolCallEventType<"ctx_execute", ContextModeInput>("ctx_execute", event)) {
			return { command: event.input.code, tool: "ctx_execute" };
		}
		if (isToolCallEventType<"ctx_execute_file", ContextModeInput>("ctx_execute_file", event)) {
			return { command: event.input.code, tool: "ctx_execute_file" };
		}
		return null;
	}

	/** Extracts a file path from various file modification tools */
	function getFilePath(event: ToolCallEvent): { path: string; tool: string } | null {
		if (isToolCallEventType("write", event)) {
			return { path: event.input.path, tool: "write" };
		}
		if (isToolCallEventType("edit", event)) {
			return { path: event.input.path, tool: "edit" };
		}
		if (isToolCallEventType<"replace", GenericFileInput>("replace", event)) {
			return { path: event.input.path, tool: "replace" };
		}
		return null;
	}

	// ── Handlers ──────────────────────────────────────────────────────────────

	async function handleShellSecurity(event: ToolCallEvent, ctx: ExtensionContext) {
		const shell = getShellCommand(event);
		if (!shell) return undefined;

		const isDangerous = DANGEROUS_BASH_PATTERNS.some((p) => p.test(shell.command));
		if (!isDangerous) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `Destructive command (${shell.tool}) blocked (no UI)` };
		}

		const choice = await ctx.ui.select(
			`⚠️ Destructive command (${shell.tool}):\n\n  ${shell.command}\n\nAllow?`,
			["No", "Yes"],
		);

		return choice === "Yes" ? undefined : { block: true, reason: "Blocked by user" };
	}

	async function handleFileSecurity(event: ToolCallEvent, ctx: ExtensionContext) {
		if (trustEdits) return undefined;

		const file = getFilePath(event);
		if (!file) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `File modification (${file.tool}) blocked (no UI)` };
		}

		const choice = await ctx.ui.select(
			`📝 Confirm ${file.tool} to:\n\n  ${file.path}\n\nAllow?`,
			["No", "Yes", "Yes, and trust edits"],
		);

		if (choice === "Yes, and trust edits") {
			trustEdits = true;
			ctx.ui.setStatus("trust-edits", ctx.ui.theme.fg("warning", " 📝 EDIT "));
			ctx.ui.notify("Trust-edits mode ENABLED", "info");
			return undefined;
		}

		return choice === "Yes" ? undefined : { block: true, reason: "Blocked by user" };
	}

	// ── Registration ──────────────────────────────────────────────────────────

	pi.registerCommand("trust-edits", {
		description: "Toggle always-allow mode for file tool edits (this session only)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on") trustEdits = true;
			else if (sub === "off") trustEdits = false;
			else trustEdits = !trustEdits;

			ctx.ui.setStatus("trust-edits", trustEdits ? ctx.ui.theme.fg("warning", " 📝 EDIT ") : undefined);
			ctx.ui.notify(`Trust-edits mode is now ${trustEdits ? "ENABLED" : "DISABLED"}`, trustEdits ? "info" : "warning");
		},
	});

	pi.registerCommand("permissions", {
		description: "Display current permission gate status and monitored tools",
		handler: async (_args, ctx) => {
			const status = trustEdits ? ctx.ui.theme.fg("accent", "TRUSTED") : ctx.ui.theme.fg("warning", "GATED");
			ctx.ui.notify(
				`Permission Gate Status:\n` +
					`- File Edits: ${status}\n` +
					`- Shell Tools: ${ctx.ui.theme.fg("warning", "ALWAYS GATED")}\n` +
					`- Monitored: bash, ctx_execute, ctx_execute_file, ${FILE_TOOLS.join(", ")}`,
				"info",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const shellResult = await handleShellSecurity(event, ctx);
		if (shellResult) return shellResult;

		const fileResult = await handleFileSecurity(event, ctx);
		if (fileResult) return fileResult;

		return undefined;
	});
}
