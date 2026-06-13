# Local Delegation Extension

[`delegate-local.ts`](../extensions/delegate-local.ts) is a Pi extension that enables a cloud orchestrator model to offload mechanical coding tasks to a fast, local worker model (such as Ollama or oMLX). The extension registers the `delegate_to_local` tool, runs the sub-task in an isolated sub-agent, and returns the worker's output along with a ground-truth git diff of any modifications.

## Usage Flow

1. **Configuration**:
   Configure the local worker model at startup or mid-session:
   ```bash
   # Startup: Configure worker via --dm
   pi --model google/gemini-2.5-pro --dm ollama/qwen3.6:35b
   ```
   ```text
   # Mid-session: View status, change, or disable the worker
   /dm
   /dm omlx/Qwen3-Coder-Next-MLX-8bit
   /dm off
   ```

2. **Execution**:
   When the orchestrator decides a task is suitable for the local worker, it calls the `delegate_to_local` tool with a specific `task`, optional `context`, and a set of `allowed_tools` (e.g., `read`, `write`, `edit`, `bash`).

3. **Verification**:
   If the worker used any mutating tools (`edit`, `write`, or `bash`), the extension appends a `git diff HEAD` to the tool's result. The orchestrator reviews the diff and can choose to keep the changes, request revisions, or run a revert command (like `git restore`).

---

## Architecture & Pi API Integration

The extension integrates directly with the Pi extension host API to handle flags, commands, and session lifecycle hooks.

### 1. Extension Hooks & Setup
During the initial factory load, the extension registers flags and lifecycle hooks:
- **CLI Flags**: Registers `--delegate-model` and `--dm` via `pi.registerFlag` to capture the worker model name.
- **Hook: `session_start`**: Fires when the session begins, reading the CLI flags to automatically parse and activate the delegation model.
- **Hook: `before_agent_start`**: Runs before each orchestrator turn to append `DELEGATION_POLICY` (guidance prompting the orchestrator on how and when to delegate tasks) to the system prompt.

### 2. Slash Command `/dm`
Registered via `pi.registerCommand`, the `/dm` command manages delegation state dynamically:
- Queries the `ctx.modelRegistry` to validate that the requested model is registered before enabling it.
- Disables delegation when `/dm off` is called (subsequent tool executions will return an error).

### 3. Dynamic Tool Registration
The `delegate_to_local` tool is not registered at factory load. Instead, it is registered dynamically via `pi.registerTool` the first time a valid delegation model is enabled (either via the startup flag or `/dm`). 
- This prevents the orchestrator from seeing the delegation tool when no local model is configured.
- Once registered, the tool remains in the orchestrator's schema, and toggling it off/on updates a runtime `delegationEnabled` flag rather than mutating the API schema.

### 4. Sub-Agent Construction
When `delegate_to_local` executes, the extension constructs an isolated sub-`Agent`:
- **API Keys**: Inherits provider credentials by supplying the `getApiKey` callback to query `ctx.modelRegistry.getApiKeyForProvider`. This ensures correct headers (e.g., `Authorization`) are populated for local or proxy endpoints.
- **Tool Mapping**: Constructs the worker's toolset from the orchestrator's allowed list using Pi's built-in tool factories (e.g., `createReadTool`, `createEditTool`).
- **Parallel Execution**: Configures the sub-agent with `toolExecution: "parallel"` for faster execution.

### 5. Conditional Git Diffing
To keep the token payload minimal and context clean:
- The extension tracks the tools executed by the sub-agent.
- If the worker called any mutating tools (`edit`, `write`, `bash`), it runs a background `git diff HEAD` and `git diff HEAD --stat` from the working directory.
- For read-only actions (like `read` or `grep`), the git diff block is omitted entirely, preventing unrelated pre-existing unstaged changes from confusing the orchestrator.
