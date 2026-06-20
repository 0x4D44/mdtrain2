# Lessons learnt

Distilled non-obvious gotchas for future sessions. Dated one-liners; newest first.

- **2026-06-20** — `vitest` transpiles with esbuild and does **NOT** typecheck. A test can
  pass `vitest run` while `tsc --noEmit` (and therefore `npm run check` / `npm run build`)
  fails on it. After editing ANY `.ts` (especially tests), run `npm run check`, not just
  vitest. (A `[x] = arr` destructure under `noUncheckedIndexedAccess` is `T | undefined`.)
- **2026-06-20** — The reactive-AI signal source must include the stations a train *serves*.
  An empty-served AI reads every station **starter** as RED (`aspectAt` is RED iff
  `!source.has(sig.protects)`) and freezes at the first one. The synthetic testbed has no
  station starters, so it masked this for the live KINGSGATE decomposition — test AI
  behaviour on the **real** route, not only the abstract fixture. `served` (station names) is
  safe to union with block tokens (edge ids) only because `validateGraph`'s OCC-NS asserts the
  two id-spaces are disjoint.
- **2026-06-20** — The simple PSR + braking-curve AI has **no cross-edge look-ahead**: it can't
  see a signal/PSR-drop on the *next* edge until it crosses onto it. So a passing loop must be
  long enough for the AI to brake from its entry speed to the loop-exit starter, or the
  approach must already be slow. Account for brake build-up lag with a planning margin
  (`AI_BRAKE_MARGIN`) so it halts at/before a red, and apply a holding brake at a stand or it
  creeps on a grade.
