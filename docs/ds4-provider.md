# [`ds4.ts`](../extensions/ds4.ts) — DeepSeek V4 Flash Provider & Lifecycle Manager

This extension registers a local provider and model config for Salvatore Sanfilippo's (antirez) [ds4](https://github.com/antirez/ds4) server to run DeepSeek V4 Flash locally, and manages the lifecycle of the local server automatically (including lazy startup, client lease tracking, and an idle watchdog).

## Requirements

- **RAM**: Running DeepSeek V4 Flash requires substantial system memory:
  - At least **128 GB RAM** for the `q2` / `q2-imatrix` quantized model.
  - At least **256 GB RAM** for the `q4` quantized model.
- **Node.js**: The extension runs in the Pi agent process and spawns the local server under Node.
- **CLI dependencies**: Uses standard UNIX utilities like `stat`, `ps`, `kill`, `sed`, `grep`, and optionally `lsof` (for TCP port state checks).

## Activation

To prevent overhead in environments where local DeepSeek V4 is not used, the extension is **opt-in** and only activates if the environment variable `DS4_ENABLED` is set:

```bash
export DS4_ENABLED=1
```

If `DS4_ENABLED` is not set, the extension returns immediately on factory load and registers no providers, commands, or hooks.

## Lifecycle Management

Rather than requiring you to manually start, stop, and configure the local `ds4-server` process, this extension handles it automatically:

1. **Lazy Startup**: When the agent targets a model with the `ds4` provider, the `before_provider_request` event handler checks if the server is already running. If not, it spawns `ds4-server` in the background.
2. **Client Lease Tracking**: On startup and at regular intervals (every 10s), the extension registers/renews a client lease file in `~/.pi/ds4/clients/<pid>.json` with metadata indicating the current Pi process is actively using the server.
3. **Idle Watchdog**: The extension starts `ds4-watchdog.sh` in the background. The watchdog polls the client leases. If no active leases are modified within 45 seconds and no other established TCP connections to port 8000 are present, the watchdog sends a `SIGTERM` (and eventually `SIGKILL` if needed) to the `ds4-server` process and exits.
4. **Shutdown Cleanup**: When the Pi session terminates (reason: `quit`), the extension deletes its client lease file. If it was the last active client, the watchdog will shut down the server.

## Configuration & Settings

Settings are resolved with the following priority:
1. Environment variables (prefixed with `DS4_`)
2. Key-value pairs in the JSON settings file at `~/.pi/ds4/settings.json`
3. Internal defaults

### settings.json format

The keys in `settings.json` map to the environment variables but are converted to camelCase (e.g. `DS4_PROTOCOL` is configured via `protocol`).

Example `~/.pi/ds4/settings.json`:
```json
{
  "protocol": "openai",
  "modelQuant": "q2-imatrix",
  "readyTimeoutMs": 600000
}
```

### Reference

| Environment Variable | JSON Key | Default | Description |
| :--- | :--- | :--- | :--- |
| `DS4_DIR` | `ds4Dir` | `~/.pi/ds4` | Base directory for runtime state, settings, logs, and leases. |
| `DS4_SETTINGS` | — | `~/.pi/ds4/settings.json` | Path to settings JSON configuration file. |
| `DS4_KV_DIR` | `kvDir` | `~/.pi/ds4/kv` | Directory for the server's KV cache disk storage. |
| `DS4_RUNTIME_DIR` | `runtimeDir` | `~/.pi/ds4/support` | Directory containing the server binaries and supporting repositories. |
| `DS4_STATE_FILE` | `stateFile` | `~/.pi/ds4/server.json` | JSON file tracking active server state (PID, URL, model). |
| `DS4_LOG_FILE` | `logFile` | `~/.pi/ds4/log` | Log file containing standard output/error from `ds4-server`. |
| `DS4_PROTOCOL` | `protocol` | `"openai"` | Wire protocol to use. Options: `openai` (`openai-completions`), `responses` (`openai-responses`), `anthropic` (`anthropic-messages`). |
| `DS4_SUPPORT_REPO` | `supportRepo` | `"https://github.com/antirez/ds4"` | Repository URL for `ds4` if not already installed. |
| `DS4_SUPPORT_BRANCH`| `supportBranch`| `"main"` | Branch of the `ds4` repository to clone/build. |
| `DS4_READY_TIMEOUT_MS`| `readyTimeoutMs`| `600000` (10 min) | Max time to wait for the local server to start and become ready. |
| `DS4_MODEL_QUANT` | `modelQuant` | (auto) | Quantization model to run. Options: `q2`, `q2-imatrix`, `q4`. (Auto-detects based on system RAM). |

## Command: `/ds4`

The extension registers a slash command `/ds4` that opens an interactive log viewer within the Pi terminal interface:

- **Usage**: Type `/ds4` in the chat prompt.
- **Features**:
  - Live log tailing of `~/.pi/ds4/log`.
  - Arrow keys, `PgUp`/`PgDn`, `Home`/`End` to scroll.
  - Press `Escape` or `q` to close and return to the chat session.

## File Map

- **[`extensions/ds4.ts`](../extensions/ds4.ts)**: The TypeScript extension that integrates with Pi, registers the provider, tracks client leases, launches the server, and provides the `/ds4` log viewer.
- **[`extensions/ds4-watchdog.sh`](../extensions/ds4-watchdog.sh)**: The background shell script launched by [`ds4.ts`](../extensions/ds4.ts) to reap the `ds4-server` process when all client leases expire.

## Attribution

This extension and watchdog script were originally adopted and modified from [mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4).

