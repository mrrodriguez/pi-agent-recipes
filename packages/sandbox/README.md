# Unified OS Sandbox Package

This package provides OS-level container isolation for the Pi coding agent. It restricts terminal commands using **Seatbelt** (`sandbox-exec`) on macOS, and **Bubblewrap** (`bwrap`) on Linux, enforcing strict filesystem and network boundaries.

## Features

- **Unified Mutation Interceptor**: Unlike simple wrappers that only sandbox standard `bash` tool calls, this extension listens to the `tool_call` event and mutates the command arguments before they run. This secures context-mode execution tools (`ctx_execute` and `ctx_execute_file` when the language is `"shell"`) as well.
- **Dynamic Configuration**: Loads and merges a global policy file (`~/.pi/agent/sandbox.json`) with optional project-local overrides (`<cwd>/.pi/sandbox.json`).
- **Safety Flags & Commands**:
  - Run `pi --no-sandbox` to temporarily run without container isolation.
  - Run `/sandbox` within a session to print the active sandbox policy rules.

## Setup & Configuration

1. Register the absolute path of this package directory at the **end** of the `packages` list in your global `~/.pi/agent/settings.json` file. This ensures it executes after pre-flight safety checks (which need to read human-readable command strings):
   ```json
   {
     "packages": [
       "/path/to/pi-agent-recipes/packages/sandbox"
     ]
   }
   ```
2. Navigate to this directory and run:
   ```bash
   npm install
   ```
3. Create your global policy file at `~/.pi/agent/sandbox.json`.

### Example `sandbox.json` Policy

Here is a recommended configuration template:

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com"
    ],
    "deniedDomains": [],
    "allowLocalBinding": true
  },
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.aws",
      "~/.gnupg"
    ],
    "allowWrite": [
      ".",
      "/tmp"
    ],
    "denyWrite": [
      ".env",
      ".env.*",
      "*.pem",
      "*.key"
    ]
  }
}
```

## Security Strategy & Architecture

To avoid command wrapping conflicts (e.g. if the sandbox wraps a command, subsequent extensions like `scoped-access` or `permission-gate` would see the compiled sandbox invocation rather than the raw shell command), ensure your extensions are loaded first:
- Auto-discovered extensions inside `~/.pi/agent/extensions/` run first.
- Explicit `packages` (in `settings.json`) run last. Keeping the sandbox in a package guarantees clean pre-flight inspections before final kernel-level execution.
