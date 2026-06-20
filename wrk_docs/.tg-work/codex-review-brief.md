# External architecture review brief — mdtrain2 track-graph HLD V2

You are an independent external reviewer from a different model family. Your job is to
adversarially review a signed-off-candidate High-Level Design (HLD), trusting NOTHING in
the document until you have checked it against the real source. A separate multi-agent
review already converged on this design; your value is finding what a panel sharing common
priors might have missed.

## What to read

1. The HLD V2 (the design under review):
   `wrk_docs/2026.06.20 - HLD - mdtrain2 track-graph - V2.md`
2. The real source it builds on (verify every load-bearing claim against these, do not
   trust the HLD's quotes):
   - `src/sim/simulation.ts` — the `step()` substep loop and the end-clamp at line 88;
     the proposed change is to add an optional `clampAtEnd = true` parameter that gates
     ONLY that forward end-clamp.
   - `src/sim/route.ts` — `aspectAt` (the R/Y/YY/G signal cascade keyed on a `served`
     Set), `gradeAt`/`speedLimitAt`/`lookup` (do they clamp past `route.length`?),
     `nextSignalAhead`.
   - `src/sim/centerline.ts` — `planarPoseAt`, the integration origin, the arc step.
   - `src/sim/controls.ts` — the AWS/penalty latch-release contract.
   - `src/sim/physics.ts` — `acceleration` (what does it read?).
   - `test/world.test.ts` — the O17 import-boundary fence.
   - `test/centerline.test.ts` — oracle O5b (the two-arc hand-rotation proof the design reuses).
   - `test/signalling.test.ts` — the G3 determinism grep and the A1–A4 station-starter cascade oracles.

## The design in one breath (verify, do not assume)

An `Edge` is the existing `Route` read through a new `EdgeFrame{psi0,x0,z0,h0}` integration
origin (identity reproduces today byte-for-byte). A pure `stepOnGraph` wraps `step()` to
carry the residual across an edge join; the only kernel change is the additive default-
preserving `clampAtEnd` parameter. Occupancy is PHYSICAL (a train occupies its current edge)
and folded into the unchanged `aspectAt` as namespaced clear-block tokens (block token = edge
id; `validateGraph` asserts edge-ids and station-ids are disjoint). `aiInputs` is a pure 1-D
target-speed tracker emitting the same `SimInputs` the player produces. `tickAll` is order-
independent via a single frame-N occupancy snapshot (no reservation, no tie-break).

## What to hunt

- A FATAL flaw or hidden coupling that makes the design wrong, unbuildable, or non-functional.
- Any claimed-unchanged file that would in fact need editing; any existing oracle the change
  silently breaks.
- A broken, circular, or VACUOUS acceptance oracle (one that can pass while the feature is
  broken). Pay attention to G-DIFF (the differential join oracle) and S1 (the headline
  player-delays-AI scenario).
- A determinism leak (clock/RNG in `src/sim`), an O17 layering violation, or a latch-contract
  break.
- Over-engineering: any abstraction, parameter, module, or oracle present for a capability the
  stated increment does not need (the binding quality brief below).
- Anything in the eight-entry decision log (section 7) that is mis-resolved.

## Binding quality brief (judge the design against this)

Simplicity and cleanliness matter; do not overengineer; one must be able to hold the
architecture in one's head. Dev sandbox: no migration, rollback, or back-compat work.
Minimize environment variables; avoid feature flags. Design for testability.

## Output format

Write a concise findings list. For each finding: SEVERITY (critical / major / minor), a
one-line title, the precise claim, the evidence (file:line you actually read), and the
smallest suggested fix. Then a final OVERALL VERDICT: is this design sound to implement as-is,
sound with the listed fixes, or is there a blocker that needs another design iteration?
Be specific and terse. Cite real line numbers. If you find the design sound, say so plainly
rather than inventing nits.
