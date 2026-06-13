import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants / prompts
// ---------------------------------------------------------------------------

const DELEGATE_SYSTEM = `You are a focused local coding worker. You receive a single
self-contained task, perform it using your tools, and produce a concise final report.
Do not ask for clarification — the orchestrator already filtered the task to be
unambiguous. Report what you did, what you read, what you changed, and any concerns.`;

const DELEGATION_POLICY = `
# Local Delegation Tool

You have access to a powerful local model via the \`delegate_to_local\` tool. Use this liberally for mechanical work to save your context window for high-level reasoning.

### How to use \`delegate_to_local\`:
- **Mechanical tasks**: "Add JSDoc to these files", "Convert this CSV to JSON".
- **Exploration**: "Find all occurrences of X and summarize them".
- **Parallelization**: Since the local model runs on the same machine, it is fast for these types of tasks.

### Heuristics for \`thinking_level\`:
- **\`off\`**: High-speed, repetitive tasks where the logic is already perfectly defined in your prompt (e.g., "Add JSDoc to these 10 files").
- **\`low\` (default)**: Best for most delegated tasks. Gives the model a moment to verify its plan without significant latency.
- **\`medium\` / \`high\`**: When the task requires multi-step discovery or self-correction (e.g., "Find all usages of X, then refactor Y, then verify with Z").

### Default tool set for the worker:
The worker defaults to \`read\`, \`grep\`, \`find\`, \`ls\`, \`edit\`, \`write\` — it can read and modify files. \`bash\` is opt-in: pass \`allowed_tools\` explicitly if the task needs it. To delegate a pure investigation with no risk of file changes, pass \`allowed_tools: ["read","grep","find","ls"]\`.

### Result shape:
- Always: the worker's final assistant text + a one-line summary of which tools it called.
- **Only when the worker actually used \`edit\`, \`write\`, or \`bash\`**: a \`git diff HEAD\` block at the end of the result for you to review what changed. If the worker didn't touch the working tree, no diff is shown — pure-investigation delegations come back clean. Note that when a diff *is* shown, it reflects the full working-tree state and may include uncommitted changes that existed before the delegation.

### Guardrails:
- The local worker has NO memory of this conversation. Provide all necessary code and context in the \`context\` parameter.
- Reference files by absolute or repo-relative path.
`;

const DEFAULT_DELEGATE_PROVIDER = "ollama";

const ALLOWED_TOOLS_DEFAULT = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
] as const;

// Tools that can plausibly modify the working tree. If the worker used none of
// these, capturing a git diff is noise — it would just surface whatever the
// user already had uncommitted, with no causal relationship to this delegation.
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

const DIFF_TRUNCATE_BYTES = 8000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DelegateParams {
  task: string;
  context?: string;
  allowed_tools?: string[];
  thinking_level?: "off" | "low" | "medium" | "high";
}

type ResolvedModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

interface WorkerOutput {
  finalMessages: AgentMessage[];
  report: string;
  /** Human-readable list, one tool call per entry. */
  toolCalls: string[];
  /** Bare tool names (e.g. "edit", "read"). Used to decide whether to capture a diff. */
  toolCallNames: string[];
  turnCount: number;
}

interface GitState {
  diff: string;
  stat: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — no closure state, no side effects beyond the noted shellouts
// ---------------------------------------------------------------------------

function buildToolSet(cwd: string, allowed: readonly string[]): AgentTool<any>[] {
  const requested = new Set(allowed);
  const tools: AgentTool<any>[] = [];
  if (requested.has("read")) tools.push(createReadTool(cwd));
  if (requested.has("grep")) tools.push(createGrepTool(cwd));
  if (requested.has("find")) tools.push(createFindTool(cwd));
  if (requested.has("ls")) tools.push(createLsTool(cwd));
  if (requested.has("bash")) tools.push(createBashTool(cwd));
  if (requested.has("edit")) tools.push(createEditTool(cwd));
  if (requested.has("write")) tools.push(createWriteTool(cwd));
  return tools;
}

function captureGitState(cwd: string): GitState {
  const diff = spawnSync("git", ["diff", "HEAD", "--no-color"], { encoding: "utf8", cwd });
  const stat = spawnSync("git", ["diff", "HEAD", "--stat", "--no-color"], { encoding: "utf8", cwd });
  return { diff: diff.stdout ?? "", stat: stat.stdout ?? "" };
}

// Split on the first "/" only, so multi-segment model IDs (e.g. "library/qwen3:32b")
// survive intact. JS String.split with a limit argument truncates rather than caps groups.
function parseModel(input: string): { provider: string; modelId: string } {
  const slash = input.indexOf("/");
  if (slash === -1) {
    return { provider: DEFAULT_DELEGATE_PROVIDER, modelId: input };
  }
  return {
    provider: input.slice(0, slash),
    modelId: input.slice(slash + 1),
  };
}

function buildWorkerPrompt(task: string, context: string | undefined): string {
  return context ? `# Task\n\n${task}\n\n# Context\n\n${context}` : task;
}

function summarizeToolCalls(messages: AgentMessage[]): {
  toolCalls: string[];
  toolCallNames: string[];
} {
  const raw = messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall") : [],
  );
  return {
    toolCalls: raw.map(
      (c: any) => `- ${c.name}(${JSON.stringify(c.arguments).slice(0, 120)})`,
    ),
    toolCallNames: raw.map((c: any) => c.name as string),
  };
}

function extractFinalReport(messages: AgentMessage[]): string {
  const final = [...messages].reverse().find((m) => m.role === "assistant");
  if (!final) return "(no output)";
  const text = final.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text || "(no output)";
}

function workerDidMutate(toolCallNames: readonly string[]): boolean {
  return toolCallNames.some((n) => MUTATING_TOOL_NAMES.has(n));
}

function truncateDiff(diff: string): string {
  if (diff.length <= DIFF_TRUNCATE_BYTES) return diff;
  const omitted = diff.length - DIFF_TRUNCATE_BYTES;
  return `${diff.slice(0, DIFF_TRUNCATE_BYTES)}\n... [truncated; ${omitted} more chars]`;
}

function renderDiffBlock(state: GitState): string[] {
  return [
    "",
    "---",
    "Ground truth (from `git diff HEAD` after the worker ran — may include any pre-existing uncommitted changes):",
    state.stat.trim() || "(no changes)",
    "",
    "Diff:",
    "```diff",
    truncateDiff(state.diff) || "(empty)",
    "```",
  ];
}

function renderToolCallsBlock(toolCalls: readonly string[]): string[] {
  return [
    "",
    "Tools used by the local worker:",
    toolCalls.length ? toolCalls.join("\n") : "(none)",
  ];
}

function buildResultText(
  report: string,
  toolCalls: readonly string[],
  gitState: GitState | null,
): string {
  const parts: string[] = [report];
  if (gitState) parts.push(...renderDiffBlock(gitState));
  parts.push(...renderToolCallsBlock(toolCalls));
  return parts.join("\n");
}

function buildResultDetails(
  model: ResolvedModel,
  output: WorkerOutput,
  gitState: GitState | null,
): Record<string, unknown> {
  return {
    model: `${model.provider}/${model.id}`,
    turns: output.turnCount,
    tool_calls: output.toolCalls.length,
    worker_mutated: gitState !== null,
    git_diff: gitState?.diff,
    git_stat: gitState?.stat,
  };
}

function errorResult(text: string, errorTag: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    details: { error: errorTag, ...extra },
  };
}

// ---------------------------------------------------------------------------
// Sub-agent run
// ---------------------------------------------------------------------------

/**
 * Construct an isolated sub-Agent, run it against the supplied prompt, and
 * collect the resulting transcript. Handles abort-signal forwarding and
 * subscription cleanup. Does NOT capture git state — that's a separate
 * concern handled by the caller based on what tools the worker actually used.
 */
async function runWorker(args: {
  model: ResolvedModel;
  ctx: ExtensionContext;
  params: DelegateParams;
  signal: AbortSignal | undefined;
}): Promise<WorkerOutput> {
  const { model, ctx, params, signal } = args;

  const allowed = params.allowed_tools ?? (ALLOWED_TOOLS_DEFAULT as readonly string[]);
  const tools = buildToolSet(ctx.cwd, allowed);

  const worker = new Agent({
    initialState: {
      systemPrompt: DELEGATE_SYSTEM,
      model,
      thinkingLevel: (params.thinking_level as any) ?? "low",
      tools,
      messages: [],
    },
    // The agent loop reads this to populate options.apiKey before calling
    // streamSimple. Without it, sub-agent HTTP calls have no x-api-key /
    // Authorization header.
    getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
    toolExecution: "parallel",
  });

  // Forward orchestrator's abort signal to the sub-agent so user-cancel propagates.
  const onAbort = () => worker.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let finalMessages: AgentMessage[] = [];
  const unsubscribe = worker.subscribe((event) => {
    if (event.type === "agent_end") finalMessages = event.messages;
  });

  try {
    await worker.prompt(buildWorkerPrompt(params.task, params.context));
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }

  const { toolCalls, toolCallNames } = summarizeToolCalls(finalMessages);
  return {
    finalMessages,
    report: extractFinalReport(finalMessages),
    toolCalls,
    toolCallNames,
    turnCount: finalMessages.filter((m) => m.role === "assistant").length,
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("delegate-model", {
    description:
      "Model for local delegation (e.g. ollama/qwen3.6:35b-a3b-coding-nvfp4). Enables the delegate_to_local tool.",
    type: "string",
  });
  pi.registerFlag("dm", {
    description: "Shorthand for --delegate-model",
    type: "string",
  });

  // Closure state persists across the lifetime of the extension instance.
  let activeProvider: string | undefined;
  let activeModelId: string | undefined;
  let delegationEnabled = false;
  let toolRegistered = false;

  const installTool = () => {
    if (toolRegistered) return;
    toolRegistered = true;

    pi.registerTool({
      name: "delegate_to_local",
      label: "Delegate (local LLM)",
      description: [
        "Hand a self-contained mechanical coding task to a fast local model that runs",
        "on this machine. Use this to save context window tokens and to parallelize work",
        "when the task does not require nuanced judgement.",
        "",
        "Use this tool for:",
        "- Bulk renames, mechanical refactors with clearly stated rules",
        "- 'Apply the same change to all files matching X'",
        "- Boilerplate generation from a precise spec",
        "- Reading and summarizing a large file or set of files into a fact list",
        "- Running a small focused investigation ('which files mention X?') and returning a digest",
        "",
        "Do NOT use this tool for:",
        "- Architectural decisions or design discussions",
        "- Ambiguous requirements that need clarification",
        "- Anything where you would need to read the result and reason carefully about it",
        "  before producing the next assistant message",
        "",
        "Provide an unambiguous, complete task description. The local agent has no",
        "memory of this conversation — give it everything it needs in `task` and",
        "`context`. Reference files by absolute or repo-relative path.",
      ].join("\n"),
      parameters: Type.Object({
        task: Type.String({
          description:
            "Complete, self-contained task description. Write as if to a competent but uncontextualized engineer.",
        }),
        context: Type.Optional(
          Type.String({
            description:
              "Pre-digested context the local model needs. Quote relevant code, list constraints, give examples. Do not reference 'our earlier conversation' — the local model cannot see it.",
          }),
        ),
        allowed_tools: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Subset of tool names the local model may call. Defaults to ['read','grep','find','ls','edit','write']. Pass a narrower list (e.g. ['read','grep','find','ls']) for pure-investigation tasks where the worker must not touch files. 'bash' is opt-in.",
          }),
        ),
        thinking_level: Type.Optional(
          Type.String({
            enum: ["off", "low", "medium", "high"],
            description:
              "Internal reasoning level for the worker. Defaults to 'low' for balanced speed/accuracy.",
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        if (!delegationEnabled || !activeProvider || !activeModelId) {
          return errorResult(
            "Delegation is disabled. Pass --dm <provider>/<model> at startup or run /dm <provider>/<model> to enable.",
            "delegation_disabled",
          );
        }

        const model = ctx.modelRegistry.find(activeProvider, activeModelId);
        if (!model) {
          return errorResult(
            `Local model '${activeProvider}/${activeModelId}' not found in the registry. Check that the relevant provider extension (e.g. ollama.ts, omlx.ts) is loaded and that the model id is correct.`,
            "model_not_found",
            { provider: activeProvider, modelId: activeModelId },
          );
        }

        const output = await runWorker({
          model,
          ctx,
          params: params as DelegateParams,
          signal,
        });

        const gitState = workerDidMutate(output.toolCallNames)
          ? captureGitState(ctx.cwd)
          : null;

        return {
          content: [
            {
              type: "text",
              text: buildResultText(output.report, output.toolCalls, gitState),
            },
          ],
          details: buildResultDetails(model, output, gitState),
        };
      },
    });
  };

  const enableDelegation = (
    provider: string,
    modelId: string,
    ctx: ExtensionContext,
  ): boolean => {
    const found = ctx.modelRegistry.find(provider, modelId);
    if (!found) {
      ctx.ui.notify(
        `Model '${provider}/${modelId}' not found. Is the corresponding provider extension loaded?`,
        "error",
      );
      return false;
    }
    activeProvider = provider;
    activeModelId = modelId;
    delegationEnabled = true;
    installTool();
    return true;
  };

  pi.registerCommand("dm", {
    description:
      "Set or show the local delegation model. Usage: /dm <provider>/<model>, /dm off, or /dm (no args) to show current state.",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        const status = delegationEnabled
          ? `Delegation ON — ${activeProvider}/${activeModelId}`
          : "Delegation OFF";
        ctx.ui.notify(status, "info");
        return;
      }

      if (trimmed.toLowerCase() === "off") {
        delegationEnabled = false;
        ctx.ui.notify(
          "Delegation disabled. /delegate_to_local calls will return an error until re-enabled.",
          "info",
        );
        return;
      }

      const { provider, modelId } = parseModel(trimmed);
      const ok = enableDelegation(provider, modelId, ctx);
      if (ok) {
        ctx.ui.notify(`Delegation model set to ${provider}/${modelId}.`, "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const rawFlag = (pi.getFlag("dm") || pi.getFlag("delegate-model")) as
      | string
      | undefined;
    if (!rawFlag) return;

    const { provider, modelId } = parseModel(rawFlag);
    enableDelegation(provider, modelId, ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (!delegationEnabled) return;
    return {
      systemPrompt: (event as { systemPrompt: string }).systemPrompt + "\n\n" + DELEGATION_POLICY,
    };
  });
}
