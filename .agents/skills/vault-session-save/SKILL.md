---
name: vault-session-save
description: Runs the vault's "save" ritual, preferring one atomic call to the brain MCP `save` tool (session summary, project update, decisions, topics, NOW.md in a single commit), falling back to granular MCP tools or local hooks; load when the user says "save" or a session is wrapping up.
license: Proprietary
---

# Vault session save

The vault (`~/obsidian/vault`) is a persistent second brain. On **"save"**, persist the session's knowledge in one atomic commit whenever possible. Do this without being asked at natural session end too.

## Preferred: one call to the `save` MCP tool

Call the brain MCP `save` tool **once**, with:
```
{ project, summary, body, next_steps, surface,
  decisions: [{decision, rationale}],
  topics: [{slug, title, content}],
  project_update: {status, next} }
```
This commits the session log, project note update, decisions, and topic notes together — no separate calls, no partial state. Populate every field you have content for; omit only what's genuinely empty this session (e.g. no new decisions).

Only create/update a `project_update` for substantive ongoing work — never for throwaway or one-off tasks. If no project was detected and this turns into real project work, ask which project it belongs to rather than inventing one.

**After saving, call `check_brain`.** Read its report (unsaved sessions, stale active projects, broken links) and fix anything it flags that belongs to your session — don't leave a hygiene issue you just caused for the next agent to find.

## Fallback 1 — granular MCP tools

If `save` is unavailable, or you only need a partial update, use the individual MCP tools instead: `append_session_log` (session log), `log_decision` (one decision + rationale), `update_note` (project note or topic). Perform the same steps semantically — summarize once, update the project note, log decisions, capture durable topics — just as separate writes instead of one commit.

## Fallback 2 — local hooks (on-disk vault work only)

When working directly on disk in the vault (no MCP available, e.g. a local Claude Code session with hooks installed):
1. Summarize the session into `logs/sessions/<date>_<time>.md` (created by the SessionStart hook). Read `logs/verbose/<base>.jsonl` **once** — it's write-only telemetry otherwise.
2. Update `projects/<slug>.md`: status, updated, next, current state.
3. Log decisions: `hooks/log-decision.sh "<decision>" "<project-slug>" "<rationale>"`.
4. Log approved plans with the body on stdin: `hooks/log-plan.sh "<title>" "<project-slug>" < plan.md` (URL stub only — see `deliverable-publish`).
5. Create `topics/<slug>.md` for durable new knowledge; update `_activity/NOW.md` if the active project changed.
6. Still finish by running `check_brain` (or the equivalent hook) and clearing anything it flags.

## Hard stops

- Read `logs/verbose/*.jsonl` exactly once, at save time — never during the session.
- Never store a plan body in the vault — URL-only stubs.
- Never fabricate a session summary; it reflects only what actually happened.
- Prefer `[[wikilinks]]` over pasting content between notes. Never copy Affinity/CRM data or PII into notes.
