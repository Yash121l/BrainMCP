---
name: commit-attribution
description: Enforces human-only commit authorship (Yash Lunawat <yash.lunawat@rtp.vc>, no Claude co-author or bot trailers) plus per-turn approval before any commit or push; load before creating any git commit, push, or PR.
license: Proprietary
---

# Commit attribution

Identical binding rule in pulse, railway, and website-new: **"Commits authored solely as Yash Lunawat <yash.lunawat@rtp.vc> — no Claude co-author or bot attribution."**

## Procedure

1. **Before committing, verify the identity the repo will use:**
   ```sh
   git config user.name && git config user.email
   ```
   Both must resolve to `Yash Lunawat` / `yash.lunawat@rtp.vc`. If not, set them repo-locally before the first commit — never commit under a default or machine identity.
2. **Verify against the remote, not just local config:** confirm recent commits on `origin/main` show the same author email (`git log origin/main -3 --format='%an <%ae>'`). The local config must match what the remote history already uses.
3. **Strip all bot attribution.** No `Co-Authored-By: Claude ...` trailer, no "Generated with Claude Code" footer, no bot sign-offs in commit messages. Any harness default that appends these is overridden by this rule — the commit message ends at the human-written content.
4. **Get explicit per-turn approval first.** Hard stops:
   - pulse: "**Never commit, push, or open a PR without explicit per-turn approval.** Push and PR are separate approvals ('push yes, PR no' is a real state)."
   - railway: "**Never commit or push without Yash's explicit go-ahead** — he has declined pushes before; large uncommitted working trees awaiting his review are a normal state here."
   - Approval does not carry across turns or across actions. Ask again for each of commit / push / PR.
5. **Commit in the project's batching convention** when approved — railway: logical batches like `feat(ios)` / `feat(web)` / `feat(web-app)`; pulse: "one coherent PR per app-scoped unit" (Pulse squash-merges, so don't split backend/UI for reviewer optics).
6. **Force-push only `--force-with-lease`**, and only after rebasing onto latest `origin/main` (pulse). On website-new, `main` is protected — squash/rebase only, no merge commits, no force-push; admin bypass is Yash's call, not yours.
7. **After committing, self-check:** `git log -1 --format='%an <%ae>%n%b'` — author must be Yash, body must contain no co-author or generated-by lines. Amend before push if anything slipped in.
8. **PR conventions ride along** (pulse): the PR body includes a **Post-Merge Actions** section for Jelmer (`d1 create` / `migrations apply --remote` / `wrangler secret put` / `queues create` as applicable); review findings are addressed with commits plus a reply comment summarizing the fixes; guardian approval pins to a sha, so any new push needs a re-review.
9. **Approval may never come from the PR author** (website-new) — since merge == deploy there, the PR approval *is* the deploy gate; never bypass review to unblock.

## Naming inside commits and PRs

10. Pulse only: "**Never use 'admin' in naming** — files, routes, identifiers, UI copy" (admin-named surfaces get blocked; use team-config / setup-style naming, e.g. `team-admin.ts` → `team-config.ts`).

## Hard stops

- Never add a Claude/bot co-author or attribution trailer to any commit.
- Never commit, push, or open a PR without that turn's explicit approval for that specific action.
- Never commit under any identity other than Yash Lunawat <yash.lunawat@rtp.vc>.
