import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Only enable if strict cost protections are requested via environment variable
  if (!process.env.PI_STRICT_COST_PROTECTIONS) {
    return;
  }

  // Thresholds: Prefer environment variables, then fallback to Pi's architectural defaults or strict presets
  const MAX_CHAR_LENGTH = Number(process.env.PI_SMART_TRUNC_MAX) || 50000;
  const KEEP_HEAD_CHARS = Number(process.env.PI_SMART_TRUNC_HEAD) || 15000;
  const KEEP_TAIL_CHARS = Number(process.env.PI_SMART_TRUNC_TAIL) || 15000;

  // Hook into tool results right after execution finishes
  pi.on("tool_result", async (event, ctx) => {
    // ToolResultEvent has a 'content' array of (TextContent | ImageContent)
    let truncatedCount = 0;
    let totalOmitted = 0;

    for (const part of event.content) {
      if (part.type === "text" && part.text.length > MAX_CHAR_LENGTH) {
        const rawOutput = part.text;
        const totalLength = rawOutput.length;

        const head = rawOutput.slice(0, KEEP_HEAD_CHARS);
        const tail = rawOutput.slice(-KEEP_TAIL_CHARS);
        const omittedCount = totalLength - (KEEP_HEAD_CHARS + KEEP_TAIL_CHARS);

        // Construct the defensive sandwich payload
        part.text = [
          head,
          `\n\n[... ⚠️ HARNESS SAFETY TRUNCATION: ${omittedCount.toLocaleString()} characters omitted from mid-section to prevent token bleed ...]\n\n`,
          tail,
        ].join("");

        truncatedCount++;
        totalOmitted += omittedCount;
      }
    }

    if (truncatedCount > 0) {
      // Provide visual feedback in Pi's terminal window
      ctx.ui.notify(
        `Truncated [${event.toolName}] output (${truncatedCount} parts). Saved ~${Math.round(totalOmitted / 4)} tokens.`,
        "warning",
      );
    }
  });
}
