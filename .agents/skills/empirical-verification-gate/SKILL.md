---
name: empirical-verification-gate
description: Requires every claim to be verified against the live API, real data, or the authoritative build tool instead of code-reading or plausibility reasoning; load before declaring anything "works", "is fixed", or "returns X".
license: Proprietary
---

# Empirical verification gate

Binding rule (pulse): **"Verify claims against real data, not code-reading alone (parse the actual CSV / hit the live API) — plausibility reasoning is not verification."** Reading source and concluding "this should work" is never sufficient to state that it does.

## Procedure

1. **Identify the claim class** before asserting it:
   - Data claim ("the API returns X", "the CSV has column Y") → hit the live API / parse the actual file and quote what came back.
   - Build/compile claim ("this compiles", "types are clean") → run the authoritative tool and read its exit status.
   - Behavior claim ("the page renders", "the flow works") → exercise it for real (see `web-ui-verification` / `ios-ui-verification`).
2. **Trust only the authoritative tool, never a proxy:**
   - iOS (railway): "`xcodebuild` (iOS Simulator) green is authoritative — **trust xcodebuild, never SourceKit single-file diagnostics**" — SourceKit false-positives against the macOS SDK (phantom "unavailable in macOS" errors, missing module-sibling members).
   - Post-agent editor diagnostics are equally untrustworthy: "don't trust the post-run editor diagnostics wall" after interrupted multi-agent runs — re-run the real build instead.
3. **Run the full quality gate before declaring done** (pulse definition of done): "`lint` + `types` + **full test suite** green before any push". Partial runs don't count as green.
4. **Verify external API shapes empirically** — real APIs lie to readers of docs. Example (railway/ConfirmTkt): field names `ChatPrepared`/`Passangers` are the API's real misspelled names, responses nest under `data.pnrResponse`, and "GET is 405 — POST only". Only a live call reveals this.
5. **Watch for false test greens:** the Workers vitest pool loads `.dev.vars`, so a test can "silently pass key-less in CI" while hitting real external APIs locally. A passing suite is only evidence if you know what it actually exercised — blank every external key the code path can reach.
6. **Re-verify after environment changes.** A verification is stale once the branch, dependencies, or external state changed under you (external merges, regenerated `worker-configuration.d.ts`, poisoned `node_modules/.vite`). Re-run the gate on the current state before repeating the claim.
7. **Smoke-test the paths tests can't reach.** Pulse gate: "cold-boot dev-server smoke when touching boot/config/migration paths; verify pages degrade gracefully before D1 migrations exist." Unit tests green does not verify boot behavior.
8. **Don't trust an error's own self-report.** `(ssr) No module found for '<X>'` "names an arbitrary file — never trust it as the culprit" (pulse). Verify the real cause (a partially written `node_modules/.vite`, other PRs showing the identical signature) before acting on an error message's claim.
9. **Report evidence, not confidence.** State what command ran, against what target, and what it returned. If you could not run the empirical check, say the claim is unverified — do not soften it into "should work".

## Scope

- Applies to every "it works / it's fixed / it returns / it renders" statement, whether headed for a PR body, a report, or a chat reply.
- Pairs with the UI skills: web claims go through `web-ui-verification`, iOS claims through `ios-ui-verification`; this gate covers everything else (APIs, data, builds, pipelines).

## Hard stops

- Never claim something works from code-reading alone.
- Never cite SourceKit or editor diagnostics as build truth — only `xcodebuild` / the real build command.
- Never push with lint, types, or the full test suite unrun or red.
