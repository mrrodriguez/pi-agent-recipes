# [`scoped-access.ts`](../extensions/scoped-access.ts) — File System Scoping & Guardrails

This extension restricts the Pi agent's file system access to specific allowed directories (by default, starting with the session's launch directory/CWD) to prevent accidental or unwanted edits or reads outside of your project directory.

## Features

- **Tool Call Filtering**: Intercepts file-related tool calls (`read`, `write`, `edit`, `replace`, `ls`, `grep`, `find`). If the target path lies outside the allowed scope, it triggers a warning/confirmation prompt.
- **Bash Command Analysis**: Scans `bash` commands for absolute, relative, or home-relative paths outside the allowed scope, deduplicates them by resolved target directory so multi-path commands only prompt once per directory, and prompts before letting the command run.
- **Dynamic Scope Expansion**: When a tool tries to access an out-of-scope path, you can allow it once (read-only or with write access) or whitelist the entire directory for the rest of the session as either `read-only` or `read-write`.
- **OS Sandbox Bridge (`pi.events`)**: Session `read-write` directory grants (`Yes (allow directory read-write for session)`, `/scope add`) and explicit one-shot write approvals (`Yes (once, allow write)`) emit `sandbox:allow-write`, `sandbox:revoke-write`, and `sandbox:allow-write-once` events so `packages/sandbox` expands or revokes Seatbelt/Bubblewrap `allowWrite` rules live without restarting Pi. Choosing `Yes (once, read-only)` or `Yes (allow directory read-only for session)` lets read operations proceed without repeated prompts while keeping the OS sandbox write lock intact (and still prompting if a mutating file tool later attempts to write to that directory).
- **Scope Management Command**: Registers a `/scope` command to inspect, add (`read-only` or `read-write`), and remove paths from the allowed set.

## Usage

When an out-of-scope access is attempted in a UI session, the extension displays a prompt:

```text
⚠️ Access outside session scope:

  Tool: read
  Path: /etc/hosts

Allow?
[No] [Yes (once)] [Yes (allow directory read-only for session)] [Yes (allow directory read-write for session)]
```

If you select `Yes (allow directory read-only for session)`, the target directory is added to the session's read scope (silencing future read/bash prompts while Seatbelt still blocks writes and mutating file tools still prompt). Selecting `Yes (allow directory read-write for session)` also grants Seatbelt write access for the session.

In non-UI (headless) environments, the tool call is blocked automatically, returning a descriptive error.

## Command: `/scope`

You can inspect or modify the allowed directories list during a session:

- **List Scopes**:
  ```text
  /scope list
  ```
  Outputs the list of currently allowed directories with their mode (`read-only` or `read-write`).

- **Add Read-Write Scope**:
  ```text
  /scope add /path/to/another/project
  ```
  Adds the resolved path to the session read-write scope (and live OS sandbox `allowWrite` paths) for the remainder of the session.

- **Add Read-Only Scope**:
  ```text
  /scope add-read /path/to/another/project
  # or: /scope add --read /path/to/another/project
  ```
  Adds (or downgrades) the resolved path to session `read-only` scope without granting OS sandbox write permissions.

- **Remove Scope**:
  ```text
  /scope remove /path/to/another/project
  ```
  Removes a dynamically added directory from the session scope and revokes its OS sandbox `allowWrite` grant if present (the launch directory cannot be removed).
