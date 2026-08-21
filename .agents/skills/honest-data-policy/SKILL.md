---
name: honest-data-policy
description: Enforces the never-show-fabricated-data-as-real policy — label estimates, say "no data" instead of inventing numbers, and ban fake social proof; load before presenting any data, metric, or content that could be simulated, estimated, or unsourced.
license: Proprietary
---

# Honest data policy

Non-negotiable product rule across every project: **"Never show fabricated data as real."** Apply this before any number, chart, demo, or claim reaches a user-facing surface or a report.

## Core rules

1. **Real errors beat simulated success.** When a live service rejects or fails, surface the service's real error. Railway rule: "a rejected PNR shows the service's real error, never simulated data."
2. **Simulated data is demo-only and gated.** Sim answers are allowed only behind explicit demo/snapshot modes (Railway gates them on `isSnapshotLaunch()`). Never let a demo path leak into a real launch.
3. **Label everything that isn't measured.** "Anything still simulated (live positions, availability grids) must be **labeled** as estimated." If a value is an estimate, projection, or placeholder, say so inline — next to the number, not in a footnote.
4. **"No data" beats invention.** Mallard rule: "If Mallard returns no rows, say 'no data' — never invent numbers." This generalizes: an empty query result, missing metric, or unanswered question is reported as missing, never filled with a plausible value.
5. **No fake social proof.** "No invented press, awards, testimonials, or rider counts ('we'll get them, then we'll show them'). Illustrative content must be labeled illustrative."
6. **Real content only on firm surfaces.** Website rule: bios/imagery come from the live source of truth (rtp.vc). Facts live in one data file (`src/data/firm.js`); "a number that isn't on a page doesn't belong" in the data at all. Never duplicate a number that already lives in data — derive it.

## Procedure

1. Before presenting any figure, trace where it came from:
   - Measured from a live system / real dataset → present as-is, cite the source.
   - Computed estimate or model output → present with an explicit "estimated" / "illustrative" label.
   - Not obtainable → say "no data". Stop. Do not interpolate, extrapolate a stand-in, or reuse a stale number silently.
2. In demos or mocks, mark simulated payloads visibly (label in the UI, comment in the code, caption in the doc) so they cannot be mistaken for production data later.
3. When an upstream API errors, propagate or display the real error state. Never substitute cached/sim data to "keep the demo smooth" outside an explicit snapshot mode.
4. In marketing or site copy, include only claims that exist today. Future proof points wait until they are real.
5. If asked to "just put in reasonable numbers", refuse and offer the honest alternatives: labeled estimate, empty state, or fetching the real value.

## Hard stops

- Never present fabricated or simulated data as real — no exceptions for demos shown to outsiders.
- Never invent a number to fill an empty result set.
- Never ship unlabeled illustrative content or invented social proof.
