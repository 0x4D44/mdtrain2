# Lessons learnt

Distilled non-obvious gotchas for future sessions. Dated one-liners; newest first.

- **2026-06-22** — Headless Playwright key presses get **lost** against this game's input model.
  The keyboard source adds `e.code` on keydown; main.ts drains the edge set every rAF frame then
  `kb.clear()`s it. A bare `page.keyboard.press()` (keydown+keyup back-to-back) can have its keyup
  `edges.delete` the code **before any frame reads it** — silently dropping the press (this was
  the real cause of `e`/`f` "not registering", not focus). Under SwiftShader the rAF loop is far
  slower than 60 fps, so a *fixed* hold (`waitForTimeout(70)`) is unreliable too. Fix: hold the key
  down across **≥2 real rAF frames** (`page.evaluate(requestAnimationFrame…)`) before releasing —
  see `e2e/night.spec.ts` `tap()`. Also: `page.screenshot()` STALLS on the perpetual WebGL canvas —
  use a `clip`-ed viewport capture (~25 s each under SwiftShader; raise the test timeout).
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
