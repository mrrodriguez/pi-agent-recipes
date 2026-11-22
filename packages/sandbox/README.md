# Unified OS Sandbox Package

This package provides OS-level container isolation for the Pi coding agent. It restricts terminal commands using **Seatbelt** (`sandbox-exec`) on macOS, and **Bubblewrap** (`bwrap`) on Linux, enforcing strict filesystem and network boundaries.

## Features

- **Unified Mutation & Policy Interceptor**: Listens to the `tool_call` event to wrap `bash` commands in Seatbelt/Bubblewrap AND enforce the same `sandbox.json` filesystem rules (`denyRead`, `denyWrite`, `allowWrite`) on built-in non-shell file tools (`read`, `ls`, `grep`, `find`, `write`, `edit`, `replace`), composing cleanly with upstream pre-flight extensions.
- **Dynamic Configuration**: Loads and merges a global policy file (`~/.pi/agent/sandbox.json`) with optional project-local overrides (`<cwd>/.pi/sandbox.json`).
- **Live Scoped Write Expansion (`pi.events`)**: Listens to `sandbox:allow-write`, `sandbox:revoke-write`, and `sandbox:allow-write-once` events emitted by `scoped-access.ts` so cross-repo write approvals update `SandboxManager` live without restarting Pi.
- **Safety Flags & Commands**:
  - Run `pi --no-sandbox` to temporarily run without container isolation.
  - Run `/sandbox` within a session to print the active base and session-scoped sandbox policy rules.

## Setup & Configuration

1. Register the absolute path of this package directory at the **end** of the `packages` list in your global `~/.pi/agent/settings.json` file. This ensures it executes after pre-flight safety checks (which need to read human-readable command strings):
   ```json
   {
     "packages": ["/path/to/pi-agent-recipes/packages/sandbox"]
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
      "~/.gnupg",
      "~/.pi/agent/auth.json",
      "~/Library/Keychains"
    ],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [
      ".env",
      "/**/.env",
      "/**/.env.*",
      "/**/*.pem",
      "/**/*.key",
      "~/.pi/agent/auth.json",
      "~/.pi/agent/models.json",
      "~/.pi/agent/settings.json",
      "~/.pi/agent/sandbox.json",
      "~/.pi/agent/mcp.json",
      "~/.pi/agent/extensions"
    ]
  }
}
```

## Security Strategy & Architecture

To avoid command wrapping conflicts (e.g. if the sandbox wraps a command, subsequent extensions like `scoped-access` or `permission-gate` would see the compiled sandbox invocation rather than the raw shell command), ensure your extensions are loaded first:

- Auto-discovered extensions inside `~/.pi/agent/extensions/` run first.
- Explicit `packages` (in `settings.json`) run last. Keeping the sandbox in a package guarantees clean pre-flight inspections before final kernel-level execution.
