# brain CLI

`brain.mjs` is a single zero-dependency Node module (Node 20+, `brain bridge` needs 22+). `install.sh` puts it at `~/.local/share/brain/brain.mjs` and symlinks `~/.local/bin/brain` to it. The `.mjs` name stays so every Node 20.x loads it as an ES module.

```sh
curl -fsSL https://brain.yashlunawat.com/cli/install.sh | sh
brain login
brain apply            # add --shell to export BRAIN_KEY from ~/.zshrc / ~/.bashrc
```

## Where things go

| What | Where |
| --- | --- |
| Key | macOS Keychain (`security`, service `brainmcp`, account = server URL); Linux `secret-tool` if present; else `~/.config/brain/credentials.json` (0600). `BRAIN_CRED_STORE=file` forces the file. |
| Config | `~/.config/brain/config.json` (server, machine, agent, store) |
| Managed state | `~/.config/brain/manifest.json` (configured agents, installed skill files, rc files) |
| Telemetry spool | `~/.cache/brain/spool` (0700), flushed in batches of 25 by a detached `brain hook flush` |
| Backups | `<file>.brain-backup`, written once before the first change to an existing file |

Agent configs and hooks call `brain` by absolute path, so apps launched outside a terminal still find it (the shebang still needs `node` on their PATH).

## Agent config written by `brain apply`

| Agent | Entry | Auth | Status |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add-json -s user brain {"type":"http","url":…,"headersHelper":"brain auth header"}` + PostToolUse hook in `~/.claude/settings.json` | headersHelper | not exercised against a real `claude` here |
| Codex | managed block in `~/.codex/config.toml`: `[mcp_servers.brain] url`, `bearer_token_env_var = "BRAIN_KEY"` | env | **unverified**: assumes a Codex build with streamable-HTTP MCP and `bearer_token_env_var` |
| Cursor | `~/.cursor/mcp.json` `mcpServers.brain` with `Authorization: Bearer ${env:BRAIN_KEY}` | env | **unverified**: relies on Cursor's `${env:…}` interpolation |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers.brain` with `httpUrl` and `Authorization: Bearer $BRAIN_KEY` | env | **unverified**: relies on Gemini expanding `$VAR` inside settings.json |
| OpenCode | `~/.config/opencode/opencode.json` `mcp.brain` (`type: remote`, `Bearer {env:BRAIN_KEY}`) | env | **unverified**: relies on OpenCode's `{env:…}` substitution; a `.jsonc`-only setup is not edited |

An agent is configured only if its binary is on PATH or its config dir exists. Only the `brain` entry, the managed block, the brain hook and skill folders listed in the manifest are touched. A skill folder that already exists and was not installed by brain is skipped unless you pass `--adopt`. Re-running `apply` also removes the hook the old `/hooks/install.sh` installed (`brain-telemetry.sh`), so tool calls are not double-counted.

## Bridge

`brain bridge` reads `~/.config/brain/bridge.json`:

```json
{ "servers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"], "env": {} } } }
```

It authenticates with the `["brain.v1", "<key>"]` subprotocol and announces its servers. Each child starts on its first message, not when the bridge starts. Request ids are remapped per child so concurrent hub sessions cannot collide. The first `initialize` goes to the child; later ones get the cached result, and after a crash the child is restarted and the handshake replayed on the next call. If the hub's first message is not `initialize` (the bridge restarted while the hub's session stayed warm), the bridge runs the handshake itself before forwarding. If the bridge is replaced by a newer one (close code 4000) it exits. If the server rejects the key (401) or refuses the bridge (403, 501), it exits with the reason. Otherwise, including when the server is unreachable, it reconnects with backoff from 1s up to 30s. Add each server in the console as `bridge://<machine>/<server>`.
