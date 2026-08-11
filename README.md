# BrainMCP

Cloudflare Worker that serves the private **`Yash121l/brain`** repo (the second-brain
vault) as an **MCP server**: `https://brain-mcp.yashlunawat-tech.workers.dev/mcp`
(streamable HTTP JSON-RPC, bearer auth, zero npm runtime deps).

**git is the source of truth; D1 is a disposable accelerator.** A GitHub push webhook
(+ nightly 03:00 UTC cron) keeps the D1 index (`brain-index`: notes table, wikilink
graph, FTS5 chunks) in sync with the brain repo. Wipe it, reindex, identical result.

## Layout
- `src/index.js` — router, MCP JSON-RPC handler, 12 tools, webhook ingest, tarball reindex, cron
- `src/parse.js` — frontmatter / wikilink / chunking (shared with the seed script)
- `src/github.js` — Contents API + Git Data API (atomic multi-file commits) + tarball reader
- `schema.sql` — D1 schema
- `scripts/build-seed.mjs` + `scripts/apply-seed.sh` — local full (re)seed: `npm run seed`
  (reads the brain repo at `$BRAIN_DIR`, default `~/obsidian/brain`)

## Tools
`get_context` `search` `read_note` `list_notes` `backlinks` `links` —
reads over the indexed brain (note paths look like `vault/projects/pulse.md`, `skills/<name>/SKILL.md`).
`append_session_log` `log_decision` `update_note` `save_session` — write-back as real
git commits to the brain repo. `list_skills` `get_skill` — serve the skills library.

## Ops
```bash
npx wrangler deploy                 # deploy
curl .../health                     # index status
curl -X POST -H "Authorization: Bearer $BRAIN_TOKEN" .../admin/reindex   # full rebuild
```
Secrets (`npx wrangler secret put`): `BRAIN_TOKEN` (MCP bearer), `GITHUB_TOKEN`
(fine-grained PAT, Contents R/W on `Yash121l/brain` only), `WEBHOOK_SECRET` (HMAC).
Local credentials copy: `~/.config/brain-mcp/credentials`.

Endpoints: `POST /mcp`, `POST /webhook`, `POST /admin/reindex`, `GET /health`.
Connection guide for every surface: `docs/CONNECT.md` in the brain repo.
