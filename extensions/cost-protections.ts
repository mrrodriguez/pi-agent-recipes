import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  // Only enable if strict cost protections are requested
  if (!process.env.PI_STRICT_COST_PROTECTIONS) {
    console.log(`[Circuit Breaker] Disabled`);
    return;
  }

  // Thresholds: Strict (4) vs Standard (30)
  const SILENT_TURN_THRESHOLD = Number(process.env.PI_SILENT_TURN_LIMIT) || 30;
  let silentTurnCount = 0;

  console.log(
    `[Circuit Breaker] Enabled (Threshold: ${SILENT_TURN_THRESHOLD})`,
  );

  // Reset counter on new user input
  pi.on("input", () => {
    silentTurnCount = 0;
  });

  // Intervene before the next turn starts
  pi.on("turn_start", async (event, ctx) => {
    if (silentTurnCount >= SILENT_TURN_THRESHOLD) {
      const confirmed = await ctx.ui.confirm(
        "Cost Protection",
        `Agent has executed tools for ${silentTurnCount} consecutive turns without interaction. Allow next turn?`,
      );

      if (!confirmed) {
        throw new Error(
          "Session aborted by user: Circuit breaker triggered due to excessive silent tool turns.",
        );
      }
      // Confirmation of the threshold crossed resets the breaker
      silentTurnCount = 0;
    }
  });

  // Track consecutive silent turns
  pi.on("turn_end", async (event) => {
    // A turn is "silent" if it contains tool calls or thinking but no substantive text for the user.
    // In TurnEndEvent, 'message' is the assistant's message for this turn.
    if (event.message.role !== "assistant") {
      return;
    }

    const message = event.message as AssistantMessage;

    const hasToolCalls = message.content.some((c) => c.type === "toolCall");

    // We also check if the assistant provided any text output to the user
    const hasAssistantText = message.content.some(
      (c) => c.type === "text" && (c as TextContent).text.trim().length > 0,
    );

    if (hasToolCalls && !hasAssistantText) {
      silentTurnCount++;
    } else {
      // Any direct communication or turn without tools resets the breaker
      silentTurnCount = 0;
    }
  });
}
