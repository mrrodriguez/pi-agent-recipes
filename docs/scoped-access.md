# [`scoped-access.ts`](../extensions/scoped-access.ts) — File System Scoping & Guardrails

This extension restricts the Pi agent's file system access to specific allowed directories (by default, starting with the session's launch directory/CWD) to prevent accidental or unwanted edits or reads outside of your project directory.

## Features

- **Tool Call Filtering**: Intercepts file-related tool calls (`read`, `write`, `edit`, `replace`, `ls`, `grep`, `find`). If the target path lies outside the allowed scope, it triggers a warning/confirmation prompt.
- **Bash Command Analysis**: Scans `bash` commands for absolute, relative, or home-relative paths that lie outside the allowed scope and prompts for confirmation before letting the command run.
- **Dynamic Scope Expansion**: When a tool tries to access an out-of-scope path, you can allow it once, or whitelist the entire directory for the rest of the session.
- **Scope Management Command**: Registers a `/scope` command to inspect and add paths to the allowed set.

## Usage

When an out-of-scope access is attempted in a UI session, the extension displays a prompt:

```text
⚠️ Access outside session scope:

  Tool: read
  Path: /etc/hosts

Allow?
[No] [Yes (once)] [Yes (allow directory for session)]
```

If you select `Yes (allow directory for session)`, the target directory is added to the session's allowed paths, and further access to it will not prompt again.

In non-UI (headless) environments, the tool call is blocked automatically, returning a descriptive error.

## Command: `/scope`

You can inspect or modify the allowed directories list during a session:

- **List Scopes**:
  ```text
  /scope list
  ```
  Outputs the list of currently allowed directories.

- **Add Scope**:
  ```text
  /scope add /path/to/another/project
  ```
  Adds the resolved path to the allowed scope list for the remainder of the session.
