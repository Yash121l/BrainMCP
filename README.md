# BrainMCP

Cloudflare Worker that serves the private **`Yash121l/brain`** repo (the second-brain
vault) as an **MCP server**: `https://brain.yashlunawat.com/mcp`
(streamable HTTP JSON-RPC, bearer auth, zero npm runtime deps).

**git is the source of truth; D1 is a disposable accelerator.** A GitHub push webhook
(+ nightly 03:00 UTC cron) keeps the D1 index (`brain-index`: notes table, wikilink
graph, FTS5 chunks) in sync with the brain repo. Wipe it, reindex, identical result.

**Nothing runs from a local checkout.** Session bootstrap, rules, skills, decisions
and saves all come from this server, so a laptop, a VPS and claude.ai behave
identically. The one exception is tool-call telemetry, which only a hook-capable
client can see at all.

## Layout
- `src/index.js` — router, MCP JSON-RPC handler, tools, webhook ingest, telemetry ingest, cron
- `src/indexer.js` — D1 index maintenance (upsert / delete / reindex one path)
- `src/skills.js` — always-on skills: `vault/skills.md` parsing, must-load resolution, catalogue
- `src/hook.js` — the PostToolUse telemetry hook + its self-extracting installer
- `src/parse.js` — frontmatter / wikilink / chunking (shared with the seed script)
- `src/github.js` — Contents API + Git Data API (atomic multi-file commits) + tarball reader
- `src/auth.js` / `src/oauth.js` — access keys (role + path/project scopes, editable in place) + the OAuth 2.1 layer for claude.ai connectors
- `src/app.js` — session login (`POST /app/login`) + the `/app/api/*` JSON API behind the web UI
- `ui/` — the browser UI: Vite + React + Tailwind + shadcn/ui SPA (notes, graph, keys),
  uploaded as Workers static assets and served at `/`. The Skills tab edits
  `vault/skills.md` (which skills bind to which project, and which load in full).
- `schema.sql` — D1 schema
- `scripts/build-seed.mjs` + `scripts/apply-seed.sh` — local full (re)seed: `npm run seed`
  (reads the brain repo at `$BRAIN_DIR`, default `~/obsidian/brain`)

## Tools
`get_context` is the session bootstrap and the only tool you must remember: it
returns a `session_id`, the always-on skills for the project (must-load bodies in
full, everything else by name), the binding rules file, the project note, and
recent decisions. `initialize` returns MCP `instructions` telling every client to
call it first, which is what replaced the old machine-local SessionStart hook.

`search` `read_note` `list_notes` `backlinks` `links` —
reads over the indexed brain (note paths look like `vault/projects/pulse.md`, `skills/<name>/SKILL.md`).
`search` hides session logs and activity mirrors by default (they are ~80% of the
vault); pass `include_logs: true` or an explicit `type`/`folder` to see them.
`save` — the whole end-of-session ritual (session log + decisions + topic notes +
project `status`/`next` patch) in ONE atomic commit. Pass the `session_id` from
`get_context` and it updates one session note instead of minting a second; `project`
is optional and omitting it files the session under `general`. Prefer it over the
granular fallbacks `append_session_log` `log_decision` `update_note` `save_session`, which
also write back as real git commits. `check_brain` — hygiene report (unsaved sessions,
stale active projects, broken wikilinks); same JSON at `GET /app/api/check`, snapshotted
nightly into `meta.hygiene` and summarised in `/health`.
`list_skills` `get_skill` — serve the skills library.

## Telemetry
The only thing still running on a machine is a `PostToolUse` hook. It redacts each
record locally, spools it to `$TMPDIR/brain-spool`, and batch-POSTs to
`/ingest/tool-calls`; a failed POST is retried on the next tool call rather than
dropped. Rows sit in D1 for the day (queryable in SQL) and the 03:00 cron rolls each
completed day into one R2 object per session at `tool-calls/<date>/<session>.jsonl`.

Install it on any machine:
```bash
curl -fsSL -H "Authorization: Bearer $KEY" https://brain.yashlunawat.com/hooks/install.sh | BRAIN_KEY=$KEY sh
```
It drops the hook, registers it in `~/.claude/settings.json`, removes any stale brain
hook, and writes the key to `~/.config/brain-mcp/credentials`. Re-run it to upgrade.

## Ops
```bash
npm run deploy                      # build ui/ then wrangler deploy
curl .../health                     # index status, hook version, telemetry buffer
curl -X POST -H "Authorization: Bearer $BRAIN_TOKEN" .../admin/reindex   # full rebuild
curl -X POST -H "Authorization: Bearer $BRAIN_TOKEN" .../admin/rollup    # drain telemetry to R2
```
Secrets (`npx wrangler secret put`): `BRAIN_TOKEN` (MCP bearer), `GITHUB_TOKEN`
(fine-grained PAT, Contents R/W on `Yash121l/brain` only), `WEBHOOK_SECRET` (HMAC).
Local credentials copy: `~/.config/brain-mcp/credentials`.

Endpoints: `GET /` (web UI), `POST /mcp`, `POST /webhook`, `POST /ingest/tool-calls`, `POST /admin/reindex`, `POST /admin/rollup`, `GET /health`, `GET /skills/install.sh`, `GET /hooks/install.sh` (self-extracting skills installer for any machine: `curl -fsSL -H "Authorization: Bearer $KEY" https://brain.yashlunawat.com/skills/install.sh | sh`).
Connection guide for every surface: `docs/CONNECT.md` in the brain repo.
