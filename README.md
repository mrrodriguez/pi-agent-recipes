# Pi Agent Recipes

A collection of reusable extensions and configuration recipes for the [Pi coding agent](https://github.com/earendil-works/pi).

## Included Extensions

- **[`delegate-local.ts`](extensions/delegate-local.ts)**: Adds a `delegate_to_local` tool to offload mechanical coding tasks (such as bulk refactoring, boilerplate generation, or exploratory reads) to a fast local model. See [delegate-local overview](docs/delegate-local-overview.md) for details.
- **[`scoped-access.ts`](extensions/scoped-access.ts)**: Restricts the agent's file system access to specific directories. See [scoped-access guide](docs/scoped-access.md) for details.
- **[`protected-paths.ts`](extensions/protected-paths.ts)**: Explicitly blocks access to sensitive system paths and files (such as `.env`, `.git`, `node_modules`, and system directories).
- **[`ds4.ts`](extensions/ds4.ts)**: Provider configuration and automatic background lifecycle/watchdog management for running local models via [ds4](https://github.com/antirez/ds4). See [ds4 provider guide](docs/ds4-provider.md) for details.
- **[`confirm-destructive.ts`](extensions/confirm-destructive.ts)**: Prompts for confirmation before clearing, switching, or forking sessions.
- **[`permission-gate.ts`](extensions/permission-gate.ts)**: Safety layer with interactive approval for destructive terminal commands and file modifications.
- **[`cost-protections.ts`](extensions/cost-protections.ts)**: Loop circuit breaker protecting against token/cost bleed from runaway silent tool loops.
- **[`smart-truncation.ts`](extensions/smart-truncation.ts)**: Truncates large tool execution outputs to protect context window tokens.
- **[`packages/sandbox/`](packages/sandbox/)**: OS-level container isolation (macOS Seatbelt, Linux Bubblewrap) using `@anthropic-ai/sandbox-runtime` with a unified tool_call mutation handler.

## Installation Methods

You can load these extensions into Pi using any of the following methods:

### Method 1: Auto-Discovery (Recommended)
Copy the extension files into one of Pi's auto-discovery directories:
- **Global Scope** (available in all projects):
  ```bash
  cp extensions/some-extension.ts ~/.pi/agent/extensions/
  ```
- **Project-Local Scope** (only loaded within the specific project directory once the project is trusted):
  ```bash
  cp extensions/some-extension.ts .pi/extensions/
  ```

### Method 2: Global Configuration (`settings.json`)
You can register extensions by adding their absolute paths to the `extensions` array in your global `~/.pi/agent/settings.json` file:
```json
{
  "extensions": [
    "/absolute/path/to/pi-agent-recipes/extensions/some-extension.ts"
  ]
}
```

### Method 3: Command-Line Flag
Load an extension for a single session using the `-e` or `--extension` flag:
```bash
pi -e ./extensions/some-extension.ts
```

---

## Extension Installation & Setup Recipes

Below are specific setup instructions for each extension.

### 1. Local Delegation (`delegate-local.ts`)
1. Copy `extensions/delegate-local.ts` to your extensions directory (e.g., `~/.pi/agent/extensions/`).
2. Run Pi with the `--delegate-model <model>` (or `--dm <model>`) flag to auto-activate the delegation tool at startup, or use the `/dm <model>` slash command mid-session to enable it.
   - *Example:* `pi --model google/gemini-2.5-pro --dm ollama/qwen3.6:35b`
3. See [delegate-local-overview.md](docs/delegate-local-overview.md) for architecture, workflow details, and customization options.

### 2. Scoped Access (`scoped-access.ts`)
1. Copy `extensions/scoped-access.ts` to your extensions directory.
2. This extension automatically monitors file-access tool calls and bash commands, prompting you for confirmation if the agent attempts to read or write files outside the launch directory.
3. Manage active directory scopes mid-session using the `/scope list` and `/scope add <path>` commands. See [scoped-access.md](docs/scoped-access.md) for details.

### 3. Protected Paths (`protected-paths.ts`)
1. Copy `extensions/protected-paths.ts` to your extensions directory.
2. This extension blocks all read and write attempts to critical and sensitive paths (such as `.env`, `.git/`, `node_modules/`, `/etc/`, etc.) by default. No additional configuration is required.

### 4. DeepSeek v4 Local Provider (`ds4.ts`)
1. Copy **both** `extensions/ds4.ts` and `extensions/ds4-watchdog.sh` into the same extensions directory (they must reside in the same folder for watchdog resolution).
2. Activate the provider by setting the `DS4_ENABLED=1` environment variable:
   ```bash
   export DS4_ENABLED=1
   ```
3. See [ds4-provider.md](docs/ds4-provider.md) for hardware requirements, lifecycle architecture, and settings.json specifications.

### 5. Confirm Destructive Actions (`confirm-destructive.ts`)
1. Copy `extensions/confirm-destructive.ts` to your extensions directory.
2. This extension automatically prompts you for verification before destructive actions, such as clearing the session history or switching/forking sessions. No additional configuration is required.

### 6. Permission Gating (`permission-gate.ts`)
1. Copy `extensions/permission-gate.ts` to your extensions directory.
2. Provides a soft confirmation gate for dangerous bash commands (`sudo`, `rm -rf`, `chmod 777`) and file modification tools.
3. Mid-session commands:
   - `/trust-edits`: Toggles bypass confirmation for file edits while keeping destructive terminal commands gated.
   - `/permissions`: Displays current gate status and list of monitored tools.

### 7. Cost Protections & Truncation (`cost-protections.ts` and `smart-truncation.ts`)
1. Copy both files to your extensions directory.
2. Activate strict loop protection and context-bleed truncation by setting the following environment variable:
   ```bash
   export PI_STRICT_COST_PROTECTIONS=1
   ```
3. Customize thresholds with these environment variables:
   - `PI_SILENT_TURN_LIMIT`: Max consecutive silent turns before pausing (default: `16`).
   - `PI_SMART_TRUNC_MAX`: Max characters allowed in tool results before truncating (default: `15000`).
   - `PI_SMART_TRUNC_HEAD` / `PI_SMART_TRUNC_TAIL`: Output bytes retained at start/end of results (default: `4000` / `4000`).

### 8. Hard Sandbox (`packages/sandbox/`)
1. Register the sandbox package at the end of the `packages` array in your global `~/.pi/agent/settings.json` file to guarantee it runs last in the extension lifecycle:
   ```json
   {
     "packages": [
       "/absolute/path/to/pi-agent-recipes/packages/sandbox"
     ]
   }
   ```
2. Navigate to the `packages/sandbox` directory and install dependencies:
   ```bash
   cd packages/sandbox && npm install
   ```
3. Create your safety policy file at `~/.pi/agent/sandbox.json` (see [packages/sandbox/README.md](packages/sandbox/README.md) for details).
4. Run Pi with the `--no-sandbox` command-line flag to temporarily bypass isolation when needed.

---

## Local Development

To type-check the extensions while editing:

```bash
npm install
npm run typecheck
```
