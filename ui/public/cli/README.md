# brain CLI

`brain.mjs` is a single zero-dependency Node module (Node 20+, `brain bridge` needs 22+). `install.sh` puts it at `~/.local/share/brain/brain.mjs` and symlinks `~/.local/bin/brain` to it. The `.mjs` name stays so every Node 20.x loads it as an ES module.

```sh
curl -fsSL https://brain.yashlunawat.com/cli/install.sh | sh
brain login            # one browser approval, one key per agent
brain apply            # add --shell to export BRAIN_KEY_CODEX etc. from ~/.zshrc / ~/.bashrc
```

## One approval, one key per agent

`brain login` detects the installed harnesses the same way `apply` does and asks for a key for each of them plus `cli` (used by `brain bridge`, `whoami` and `doctor`): for example `cli, claude-code, codex, cursor`. You approve the machine once in the console, and the approval mints one key per agent, all bound to this machine. Each harness then talks to BrainMCP under its own identity, so per-agent rules, revocation and the audit log in the console mean something: revoking `cursor @ laptop` leaves Claude Code and Codex working.

- `brain login --agents codex,gemini` asks only for those (up to 8 per login); `--agent opencode` for one. Keys from an earlier login on the same server are kept.
- `brain auth header --agent claude-code` / `brain auth token --agent codex` print one agent's key (default `cli`). There is no fallback: an agent without a key gets an error telling you to run `brain login --agents <name>`.
- `brain apply` points each harness at its own key and lists any harness that has none yet.
- A login made before per-agent keys (one key) is migrated to agent `cli` on first use; run `brain login` again to give each harness its own key.
- Headless boxes: `BRAIN_KEY_<AGENT>` (e.g. `BRAIN_KEY_CODEX`) in the environment is used when nothing is stored for that agent. Plain `BRAIN_KEY` (+ `BRAIN_URL`) only counts when there is no stored login at all.

## Where things go

| What | Where |
| --- | --- |
| Keys | One per agent. macOS Keychain (`security`, service `brainmcp`, account `<server>#<agent>`); Linux `secret-tool` (same account); else `~/.config/brain/credentials.json` (0600, `{ "server", "keys": { "<agent>": "<key>" } }`). `BRAIN_CRED_STORE=file` forces the file. |
| Config | `~/.config/brain/config.json` (server, machine, agents, store) |
| Managed state | `~/.config/brain/manifest.json` (configured agents, installed skill files, rc files) |
| Telemetry spool | `~/.cache/brain/spool/<agent>` (0700), flushed in batches of 25 by a detached `brain hook flush --agent <agent>` with that agent's key (falls back to the `cli` key if the agent has none) |
| Backups | `<file>.brain-backup`, written once before the first change to an existing file |

Agent configs and hooks call `brain` by absolute path, so apps launched outside a terminal still find it (the shebang still needs `node` on their PATH).

## Agent config written by `brain apply`

| Agent (key) | Entry | Auth | Status |
| --- | --- | --- | --- |
| Claude Code (`claude-code`) | `claude mcp add-json -s user brain {"type":"http","url":…,"headersHelper":"<abs brain> auth header --agent claude-code"}` + PostToolUse hook `<abs brain> hook post-tool --agent claude-code` in `~/.claude/settings.json` | headersHelper | not exercised against a real `claude` here |
| Codex (`codex`) | managed block in `~/.codex/config.toml`: `[mcp_servers.brain] url`, `bearer_token_env_var = "BRAIN_KEY_CODEX"` | env | **unverified**: assumes a Codex build with streamable-HTTP MCP and `bearer_token_env_var` |
| Cursor (`cursor`) | `~/.cursor/mcp.json` `mcpServers.brain` with `Authorization: Bearer ${env:BRAIN_KEY_CURSOR}` | env | **unverified**: relies on Cursor's `${env:…}` interpolation |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json` `mcpServers.brain` with `httpUrl` and `Authorization: Bearer $BRAIN_KEY_GEMINI` | env | **unverified**: relies on Gemini expanding `$VAR` inside settings.json |
| OpenCode (`opencode`) | `~/.config/opencode/opencode.json` `mcp.brain` (`type: remote`, `Bearer {env:BRAIN_KEY_OPENCODE}`) | env | **unverified**: relies on OpenCode's `{env:…}` substitution; a `.jsonc`-only setup is not edited |

`brain apply --shell` writes one export per env-based agent into a managed block in `~/.zshrc` / `~/.bashrc`, e.g. `export BRAIN_KEY_CODEX="$(brain auth token --agent codex)"`. Apps launched outside a terminal (Cursor from the Dock) do not read those files.

An agent is configured only if its binary is on PATH or its config dir exists. Only the `brain` entry, the managed block, the brain hook and skill files listed in the manifest are touched. A skill folder that already exists and was not installed by brain is skipped unless you pass `--adopt`. Skill sync and uninstall never go through a symlink: every directory from the skills folder down to a file must be a real directory inside it, a symlink at a file's own path is replaced rather than written through, and a file that is a symlink (or sits under one) is left in place and reported instead of deleted.

## Telemetry redaction

The hook keeps only a summary of each tool call (command, path, URL, scalar args) and redacts it before it is spooled: value patterns shared with the server's Python hook (`src/hook.js`: bearer tokens, `sk-`/`ghp_`/`xox?-`/AKIA keys, JWTs, private keys, `--password=`, `token=`), plus key names. Any string, array or object under a key containing `password`, `passwd`, `secret`, `token`, `api_key`/`apikey`/`api-key`, `authorization`, `auth` (not `author`), `cookie`, `session`, `private_key` or `credential` (any case, `-`/`_` ignored, so `githubToken` and `X-Api-Key` match) becomes `<REDACTED>`, at any depth. Re-running `apply` also removes the hook the old `/hooks/install.sh` installed (`brain-telemetry.sh`), so tool calls are not double-counted.

## Bridge

`brain bridge` reads `~/.config/brain/bridge.json`:

```json
{ "servers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"], "env": {} } } }
```

It authenticates with the `["brain.v1", "<key>"]` subprotocol and announces its servers. Each child starts on its first message, not when the bridge starts. Request ids are remapped per child so concurrent hub sessions cannot collide. The first `initialize` goes to the child; later ones get the cached result, and after a crash the child is restarted and the handshake replayed on the next call. If the hub's first message is not `initialize` (the bridge restarted while the hub's session stayed warm), the bridge runs the handshake itself before forwarding. If the bridge is replaced by a newer one (close code 4000) it exits. If the server rejects the key (401) or refuses the bridge (403, 501), it exits with the reason. Otherwise, including when the server is unreachable, it reconnects with backoff from 1s up to 30s. Add each server in the console as `bridge://<machine>/<server>`.
