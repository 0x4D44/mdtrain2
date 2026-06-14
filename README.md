# mdtrain2

An improved UK EMU cab simulator — the successor to
[`mdtrain`](https://github.com/0x4D44/mdtrain). The original is preserved
unchanged (and kept runnable under [`legacy/`](legacy/)) as a record of what AI
coding tools produced in early 2026; this is the "what they can do now" answer.

**The target:** a GTO-inverter EMU running an improved Westford→Eastbank line,
at night in the rain — wipers, signal glow, wet-rail reflections — driven
first-person from a detailed cab, with the inverter "gearbox" whine rising under
power.

Unlike the original (one 2,800-line HTML file), mdtrain2 is built as a proper
project with a **pure, deterministic, tested simulation core** (`src/sim/`)
cleanly separated from rendering, audio and input. See
[`wrk_docs/2026.06.14 - PLN - mdtrain2 design.md`](wrk_docs/) for the full plan.

## Develop

```
npm install
npm run dev      # http://localhost:5173
npm test         # vitest — physics/braking/reverser oracles
npm run check    # typecheck + tests
npm run build    # static bundle into dist/
```

## Status

Phase 0 (foundation): tested sim core + a thin render thread that drives the
camera along the rails. Cab, signalling, audio and the wet-night look follow in
later phases.

Controls (Phase 0): `W`/`S` power · `A`/`D` brake · `X` reverse.
