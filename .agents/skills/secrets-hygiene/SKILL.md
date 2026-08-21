---
name: secrets-hygiene
description: Prevents secret leakage by banning any printing of secrets (even lengths or edge characters) and treating anything pasted in chat as exposed-and-rotate; load whenever handling API keys, tokens, .dev.vars, or credential-adjacent config.
license: Proprietary
---

# Secrets hygiene

Binding rule (pulse): **"Never log or print secrets — even partial (length/edge chars count as leaks; the push-to-rearview.gs lesson)."** Partial disclosure is disclosure.

## Procedure

1. **Never print a secret in any form.** That includes:
   - The full value, obviously.
   - Prefixes/suffixes ("starts with `sk-ant`"), lengths, character classes, checksums, or "masked" forms like `sk-***xyz`.
   - Echoing it via debugging (`console.log(env)`, `env | grep`, printing a request's auth header, dumping a config object that contains it).
2. **Keep keys only in git-ignored files.** "Keys live only in git-ignored `.dev.vars`." Never write a secret into tracked source, a commit message, a PR body, a vault note, or a test fixture.
3. **Chat = exposed.** "Anything pasted in chat = exposed → tell Yash to rotate it." If a secret appears in the conversation — pasted by the user, surfaced in tool output, or leaked by a command you ran — immediately tell Yash that specific credential must be rotated. Do not reason that it was "probably fine".
4. **Transport secrets over the approved channel only:** "Secret values travel via Slack DM, never in PR bodies or chat."
5. **When a command needs a secret**, reference it by environment variable or file (`$MY_KEY`, `--env-file .dev.vars`) so the value never lands in shell history, logs, or your output. Prefer commands whose output cannot contain the secret; if output might, redirect or filter it before reading.
6. **Beware of test-time leakage paths:** the Workers vitest pool loads `.dev.vars`, so tests can silently reach real external APIs with real keys. Blank every external key the exercised code path can reach (`env.X = ""` from `cloudflare:test`) — both to avoid side effects and to keep keys out of recorded test traffic.
7. **Prod access boundaries are real:** the prod Cloudflare account is Jelmer's — "Yash has no prod secret/deploy access." Never attempt to read, set, or work around prod secrets; post-merge `wrangler secret put` goes in the PR's Post-Merge Actions section for Jelmer.
8. **Vault hygiene:** keep PII and credentials out of plaintext notes entirely. Point to the system of record instead of copying values.

## Verification before hand-off

9. Before committing or ending a task, sweep your own trail:
   - `git diff --staged` contains no key-shaped strings and no new un-ignored env files.
   - Nothing you printed this session contained a credential; if a tool's output did, flag rotation now (rule 3) — deleting the message does not un-expose it.
   - Any new secret the work requires is documented by *name only* (e.g. "needs `NEWAPP_API_KEY` set via `wrangler secret put`") in the PR's Post-Merge Actions, value delivered by Slack DM.

## Hard stops

- Never print, log, or paraphrase any part of a secret — length and edge characters included.
- Never commit a secret or place one in a PR body, note, or chat message.
- A secret seen in chat is burned: flag it for rotation immediately, every time.
