# HLD — Track Graph + Multiple Deterministic Trains (RISK-FIRST angle)

**Status:** DRAFT · Date 2026-06-20 · Angle: **RISK-FIRST** · Target `C:\worktrees\mdtrain2\track-graph`
**Provenance:** lead-authored against current HEAD (Phase 0–5 merged, `package.json` 0.12.0). This adds a **track graph** (multiple tracks, points, a branch, a passing loop), **N deterministic trains** (one player on a booked route + reactive-AI services), and **occupancy-driven signalling** so trains hold each other at red — all on top of the **already-tested pure `(s,d)` core**, which is the asset we refuse to disturb. `package.json` 0.12.0 → 0.13.0.
**One-line thesis:** an **Edge is today's `Route` with the integration origin lifted from the hard-wired `(ψ=0, 0,0, h=0)` to an `EdgeFrame`** — every geometry function stays byte-identical, the graph is just frames handed node-to-node; a thin **pure `stepOnGraph` wrapper carries the residual onto the next booked edge** without touching `step()`; **occupancy is a derived richer set source feeding the unchanged `aspectAt` cascade**; AI is a **pure `aiInputs` producing the same `SimInputs`**. Every risky seam has a named oracle that fails the build.

This draft leads with the **failure modes that could break the tested core or determinism**, then designs backward from each. Every risk **R-n** carries a named mitigation and a check (oracle **On**).

---

## 0. Risk register (lead with the failure modes)

| # | Failure mode | Why it bites | Mitigation (named) | Check |
|---|---|---|---|---|
| **R1** | **Junction sign/orientation flip** — train teleports, reverses, or kinks crossing a node | The residual `s` and the velocity sign must transfer onto the child edge consistently; this is the single most error-prone seam | **Forward-only, same-sense booking (D1):** every booked hand-off is parent-exit → child-entry with the child's `EdgeFrame = parent.exitFrame`; the residual carries as `s' = s − parent.length`, sign unchanged. **No mid-edge reversal across a node.** | O-G1, O-G2 (continuity ≤ 1e-6), O-CARRY |
| **R2** | **Geometry math drifts from byte-identical** | If `placeOnCentreline`/`planarPoseAt`/`heightAt` are rewritten rather than reparameterised, the 250+ existing geometry assertions can silently shift | **Origin-parameterisation only (D6):** the functions gain an `EdgeFrame` arg that **defaults to identity**; with the identity frame the output is bit-for-bit the legacy output. The legacy `Route` call sites become `frame = IDENTITY`. | O-IDENT (byte-identity), existing centerline.test.ts unchanged |
| **R3** | **Occupancy fails to hold the follower** — two trains share a block, no red | A train in the block ahead must turn the protecting signal RED; if the set source is wrong the follower runs through | **Occupancy is a derived set folded into the SAME `served`-style source (D3):** `aspectAt` reads `served ∪ blocksClearAhead`; an occupied block ahead is simply **absent** from the clear set ⇒ the protecting signal is held RED by the *unchanged* cascade. | O-OCC-HOLD, O-OCC-CASCADE |
| **R4** | **Occupancy fails to RELEASE** — follower stuck after the leader clears | The latch contract (controls.ts:241-251) must not be hand-tugged; a stale hold must self-clear when the source stops demanding it | **Occupancy is re-derived fresh every tick from live `TrainPosition`s (D3),** exactly like AWS reasons are re-folded (aws.ts:264). It is never stored, so it cannot go stale; the `aspectAt` source set simply regains the block the same tick the leader vacates it. | O-OCC-RELEASE |
| **R5** | **Replay non-determinism with N trains** | Order-of-iteration, clock, or RNG creep makes two runs of the same scenario diverge; trips G3 | **Order-independent tick (D5):** derive occupancy from ALL trains' frame-N positions FIRST, THEN step every train on the shared clamped `dt`; tie-break block contention by a **fixed total order on `trainId`**. New modules are pure, dt-/position-driven; G3 grep already covers `src/sim/*.ts`. | O-DET (replay), G3 |
| **R6** | **Per-edge invariant violation** — a child edge has R<250 or a folded ribbon | The per-route invariants (minR≥250, O-RIBBON, κ=0 bands, cant-off-ceiling PSR) must hold per-edge AND graph-wide | **Invariants become per-edge + a graph-level oracle (D6):** each Edge satisfies the legacy per-route checks; a graph oracle asserts every edge passes AND every node hand-off is C0/G1-continuous. | O-EDGE-INV, O-G1, O-G2 |
| **R7** | **`step()` thickened** — the tested kernel grows graph logic | Any branch added inside `step()` risks the 164 tests and the dt-slice independence proof | **`stepOnGraph` is a NEW pure layer OVER the UNCHANGED `step()` (D2):** it calls `step()` on the current edge, detects `s ≥ edge.length`, and re-enters `step()` on the next booked edge with the residual. `step()` keeps its end-clamp; the clamp only *fires* at a true buffer-stop edge. | O-STEP-PARITY, existing simulation tests unchanged |
| **R8** | **AI train mis-signals / penalty-loops** | A full AWS/penalty machine on AI makes them brake-latch and stall unrealistically; over-complex | **Reduced read-aspect-and-obey AI controller (D7):** `aiInputs` tracks a target speed = min(PSR ahead, red/yellow braking curve, booked constraint). No AWS magnets, no DSD, no penalty latch on AI. | O-AI-TRACK, O-AI-STOP |
| **R9** | **`d`-offset misused for the loop / branch** | Modelling the passing loop as a `d`-offset on one edge couples two independent occupancies onto one chainage | **Parallel running track = a DISTINCT edge, not a `d`-offset (D8):** `d` stays a *within-edge lateral* (rail gauge, platform side, stagger) exactly as today; the loop and branch are their own edges with their own occupancy. | O-OCC-LOOP |
| **R10** | **Render couples to sim / O17 breaks** | AI-train meshes must be placed without `src/sim` importing render, and the physics path must not import the spatial core | **AI trains are NEW meshes via the EXISTING `placeOnCentreline(edge, s, 0)` primitive (D-rend),** the same call lineside furniture uses. `stepOnGraph`/occupancy live in `src/sim` and import only `simulation`/`route`/`centerline`-types; physics path still imports no spatial core. | O17 (extended), O-LAYER |

The rest of the document discharges every row above.

---

## 1. Scope & non-goals

### In scope
1. **Edge + EdgeFrame** (`src/sim/graph.ts`, NEW, PURE, TESTED) — an `Edge` is a `Route` restricted to one node-to-node span (its own length / grades / speedLimits / curvatures / signals / optional viaducts/tunnels/terrainSeed) plus an `EdgeFrame` integration origin `(psi0, x0, z0, h0)`. Today's single `Route` is the special case `EdgeFrame = IDENTITY`.
2. **Origin-parameterised geometry** (`src/sim/centerline.ts`, CHG, PURE, TESTED) — every geometry function gains an **optional trailing `EdgeFrame` argument defaulting to `IDENTITY`**. With the default it is **byte-identical** to today. This is the keystone change and the *only* edit to the tested geometry math.
3. **TrackGraph + Node** (`src/sim/graph.ts`, NEW, PURE, TESTED) — nodes (points) hand the exit frame of one edge to the entry frame of the next; a `TrackGraph` is `{ nodes, edges }`. Continuity is a **graph-level oracle** (`entryFrame(child) == exitFrame(parent)` within 1e-6 in position + heading).
4. **TrainPosition + Path** (`src/sim/graph.ts`, NEW, PURE, TESTED) — `TrainPosition = { edgeId, s, d }` replaces the scalar `SimState.chainage` *for graph-aware code* (the kernel `SimState` is untouched; see D2). A `Path` is an **ordered list of edgeIds = the booked route** (player + each AI service). The scenario sets the points, so a `Path` is **data** — no interlocking UI, no runtime pathfinding.
5. **`stepOnGraph`** (`src/sim/graph.ts`, NEW, PURE, TESTED) — a thin wrapper that calls the **UNCHANGED `step()`** on the current edge and, when `s` crosses `edge.length`, carries the residual onto the next booked edge and re-enters `step()`. The most error-prone seam, isolated to one tested function.
6. **Occupancy predicate** (`src/sim/occupancy.ts`, NEW, PURE, TESTED) — a **derived** (never stored) `blocksClearAhead(graph, positions)` set, swapped into the `aspectAt` source alongside `served`. A train occupying the block ahead is absent from the clear set ⇒ the protecting signal holds RED.
7. **AI controller** (`src/sim/ai.ts`, NEW, PURE, TESTED) — `aiInputs(...)` producing the **same `SimInputs`** as `resolveInputs`: a target-speed tracker over `min(PSR ahead, red/yellow braking curve, booked-path constraint)`.
8. **Multi-train tick** (`src/sim/multitrain.ts`, NEW, PURE, TESTED OR folded into `graph.ts`) — an order-independent tick: derive occupancy from all trains' frame-N positions, then step every train on the shared clamped `dt`. Per-train records replace the single `(state, controls, safety, aws)`.
9. **First testbed graph + scenario** (`src/sim/graph.ts` data, NEW) — a small **through line + passing loop + a junction to a branch**, with **one AI service the player can hold at a red** (§4).
10. **Render: AI trains as world objects** (`src/render/trains.ts`, NEW, impure adapter) — AI-train meshes placed via the existing `placeOnCentreline(edge, s, 0)` + heading. The player camera stays single-train.

### Non-goals
- **No manual point-setting and no interlocking UI.** The scenario books every Path; points are data, not player input.
- **No runtime pathfinding / routing engine.** A Path is an authored edge list.
- **No timetable / platform-dwell AI in increment 1** (deferred behind a clean seam — D7). The first AI service is a pure PSR + braking-curve tracker that the player can hold at red.
- **No new signalling *rules*.** The R→Y→YY→G cascade and its strictly-increasing-index termination proof are reused verbatim; occupancy is a *richer set source*, not a new aspect kind or a new primitive.
- **No multiplayer, no new npm dependency, no new env var, no feature flag.**
- **No rewrite of `step()` or the geometry math.** Additive only. The 164 existing tests must pass unchanged.
- **No removal of `WESTFORD_EASTBANK` / `KINGSGATE_SEAHAVEN`.** They remain single-edge graphs (`EdgeFrame = IDENTITY`) so every existing test is untouched.

---

## 2. The design

The whole feature rests on **one diagram in your head**:

```
  Edge = Route + EdgeFrame(ψ0,x0,z0,h0)        ── the ONLY new geometry concept
        │
        ├─ centerlineAt(edge, s, frame=IDENTITY)   ── byte-identical at IDENTITY (D6, R2)
        │     placeOnCentreline / planarPoseAt / heightAt / headingAt / cantAt
        │
  TrackGraph = { nodes, edges }   node: exitFrame(parent) ──hands──► entryFrame(child)   (R1,R6)
        │
  Path  = [edgeId, edgeId, …]   ── the booked route, DATA set by the scenario
        │
  TrainPosition = { edgeId, s, d }
        │
  stepOnGraph(spec, graph, path, pos, state, inputs, dt)        (R7)
        │   calls UNCHANGED step() on the current edge; on s≥edge.length
        │   carries residual onto the next booked edge and re-enters step()
        │
  occupancy: blocksClearAhead(graph, positions[])  ── derived set (R3,R4)
        │
  aspectAt(edge, i, served ∪ blocksClearAhead)   ── UNCHANGED cascade, RICHER source
        │
  player → resolveInputs (unchanged)   ┐
  each AI → aiInputs (tracks target)   ┘──► step() / stepOnGraph
        │
  render: placeOnCentreline(edge, s, 0) + heading  ── AI trains as world meshes (R10)
```

### 2.1 EdgeFrame — the integration origin lifted (R1, R2, R6)

The keystone. `planarPoseAt` (centerline.ts:90-94) today hard-wires the integration origin: `x=0, z=0, psi=0` and `heightAt` measures from `y=0`. **An `EdgeFrame` is exactly that origin, made a parameter:**

```ts
/** The integration origin for an edge's geometry. Identity = today's behaviour. */
export interface EdgeFrame {
  x0: number;    // world X of the edge's s=0 point
  z0: number;    // world Z of the edge's s=0 point
  h0: number;    // world Y (datum height) of the edge's s=0 point
  psi0: number;  // entry heading ψ₀ (rad); heading=0 ⇒ tangent=+Z
}
export const IDENTITY: EdgeFrame = { x0: 0, z0: 0, h0: 0, psi0: 0 };
```

The change to the geometry math is **mechanical and minimal** — `planarPoseAt` seeds the accumulators from the frame instead of zeros, and the closing rotation is the same arc math, just started at `psi0`:

```ts
export function planarPoseAt(
  route: Route, s: number, frame: EdgeFrame = IDENTITY,
): { x: number; z: number; heading: number } {
  let x = frame.x0;        // was 0
  let z = frame.z0;        // was 0
  let psi = frame.psi0;    // was 0  (ψ₀ at s=0)
  // … the EXACT existing step()/arc accumulation, unchanged …
}
```

- `heightAt(route, s, frame=IDENTITY)` adds `frame.h0` to the returned integral (`return frame.h0 + h`). The integral itself is untouched.
- `headingAt`, `centerlineAt`, `cantAt`, `placeOnCentreline` thread `frame` through to `planarPoseAt`/`heightAt`. `cantAt` is **frame-invariant** (depends only on `κ` and the posted limit), so it is unaffected — a useful invariant we assert (O-IDENT).
- **Byte-identity guarantee (R2):** with `frame = IDENTITY`, `x0=z0=h0=psi0=0`, so the seeds are the literal `0`s the code already has and `frame.h0 + h == h`. The output is bit-for-bit identical. The existing `centerline.test.ts` (which never passes a frame) exercises the identity path and must pass **unchanged** — that is oracle **O-IDENT**.

**Why this is safe.** The two-arc hand-rotation test (`centerline.test.ts:188`, O5b) already proves that the arc accumulation composes correctly when the *second* arc starts from a non-zero entry heading `ψ₀=θ1`. An `EdgeFrame` is precisely "start the *first* arc from `ψ₀` and offset the origin by `(x0,z0,h0)`" — the **same rigid transform** the hand-rotation test validates, applied at `s=0` instead of mid-route. The math is not new; it is the proven math invoked with a non-identity seed.

### 2.2 TrackGraph, Node, and the node hand-off (R1, R6)

```ts
export interface Edge {
  id: string;
  route: Route;        // the per-edge (s,d) data: length, grades, speedLimits,
                       // curvatures, signals, optional viaducts/tunnels/terrainSeed
  frame: EdgeFrame;    // integration origin (IDENTITY for the legacy single-line)
}
export interface Node {
  id: string;
  /** edges entering this node (their s=length end) and leaving it (their s=0 end). */
  inEdges: string[];
  outEdges: string[];
}
export interface TrackGraph {
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
}
```

**The hand-off rule (D1).** A node hands the **exit frame** of an in-edge to the **entry frame** of an out-edge. The exit frame is computed once, at graph-build time, from the parent edge's own geometry:

```ts
/** The pose at the END of an edge, in world coords — the frame its successors inherit. */
export function exitFrame(edge: Edge): EdgeFrame {
  const p = planarPoseAt(edge.route, edge.route.length, edge.frame);
  return { x0: p.x, z0: p.z, h0: heightAt(edge.route, edge.route.length, edge.frame), psi0: p.heading };
}
```

A graph is **authored** so that `child.frame == exitFrame(parent)` for every booked hand-off. We do not compute it at runtime; we **assert** it (O-G1). **Divergence (the branch / loop) is baked into the child edge's own curvature**, not into an explicit turnout geometry (D6): the loop edge starts at the same frame as the main edge but its `route.curvatures` bows it aside and back (an S of κ within the per-edge R≥250 budget); the branch edge starts at the junction node's exit frame and curves away. This keeps **all** geometry inside the proven `planarPoseAt` arc math — no new turnout primitive, no second geometry path to test.

**Continuity oracles (R6):**
- **O-G1:** for every authored hand-off, `exitFrame(parent)` equals `child.frame` within 1e-6 in `(x0,z0,h0,psi0)`.
- **O-G2:** position + heading are C0/G1 at the node (same point, same tangent direction) — a direct corollary, asserted on the sampled frames either side of the join.

### 2.3 TrainPosition, Path, and the kernel boundary (R7)

```ts
export interface TrainPosition { edgeId: string; s: number; d: number; }
export type Path = string[]; // ordered edgeIds = the booked route
```

`TrainPosition` is the **graph-aware** position. The kernel `SimState.chainage` (simulation.ts:23) stays a plain scalar — **we do not touch `SimState` or `step()`** (D2). The bridge is: `state.chainage` is the train's `s` *on its current edge*, and `pos.edgeId` says which edge that is. `stepOnGraph` owns the mapping; `step()` never knows the graph exists.

A `Path` is the ordered list the scenario books. `nextEdge(path, edgeId)` is a pure lookup: the edge after `edgeId` in `path`, or `null` at the end (a buffer-stop edge).

### 2.4 stepOnGraph — the residual carry (R1, R7)

This is the seam the whole feature lives or dies on, so it is **one small pure function with its own oracle**:

```ts
export function stepOnGraph(
  spec: TrainSpec, graph: TrackGraph, path: Path,
  pos: TrainPosition, state: SimState, inputs: SimInputs, dt: number,
): { pos: TrainPosition; state: SimState } {
  const edge = graph.edges[pos.edgeId];
  // 1. Step on the CURRENT edge with the UNCHANGED kernel.
  let st = step(spec, edge.route, state, inputs, dt);
  let edgeId = pos.edgeId;

  // 2. Carry the residual across as many node hand-offs as dt produced.
  //    Forward booking only (D1): same sense, sign unchanged.
  while (st.chainage >= edge_(graph, edgeId).route.length && inputs.dir === 1) {
    const next = nextEdge(path, edgeId);
    if (next === null) break;            // true buffer stop ⇒ step()'s end-clamp stands
    const residual = st.chainage - edge_(graph, edgeId).route.length;
    edgeId = next;
    st = { ...st, chainage: residual };  // RESIDUAL carries; speed/brakeActual/time UNCHANGED
  }
  return { pos: { edgeId, s: st.chainage, d: pos.d }, state: st };
}
```

**Junction sign/orientation reconciliation (D1, the resolved open decision).** We make a **deliberate simplifying choice that collapses the hardest risk**: booked hand-offs are **forward-only and same-sense**. Because `child.frame == exitFrame(parent)`, the parent's exit *tangent* is the child's entry *tangent*; advancing `s` on the child continues in the **same world direction**, so `SimInputs.dir` and the velocity sign **do not change** across a node. The residual `s' = chainage − parent.length ≥ 0` simply continues at `s'` on the child. There is **no sign flip to reconcile** for booked forward running — we have designed the flip out of existence.

- Reverse running (`dir === -1`) does **not** cross a node in increment 1: the while-loop is gated on `dir === 1`, and `step()`'s `chainage<=0` clamp (simulation.ts:85-87) holds the train at the edge's `s=0` start. (A reverse hand-off would need the symmetric carry onto the *previous* booked edge; it is a clean, separately-tested extension and is **out of scope** for the first increment.)
- The end-clamp `chainage=route.length, speed=0` (simulation.ts:88-91) **only fires when `nextEdge` is null** — i.e. a true buffer-stop edge (the terminus). On a through edge the residual carries before the clamp can bite, because `stepOnGraph` re-homes `chainage` onto the child the same tick.

**O-CARRY (the carry oracle, R1):** a train driven through a node at a chosen speed lands on the child edge at the residual `s`, and its **world pose is continuous** — `placeOnCentreline(child, residual, d)` equals `placeOnCentreline(parent, parent.length + residual_virtual, d)` would, i.e. there is no positional jump across the join (proven by O-G1 plus the residual algebra). Speed, brakeActual, and time are **invariant** across the carry.

**O-STEP-PARITY (R7):** on a single-edge graph (`IDENTITY`, no successor), `stepOnGraph` produces **bit-identical** `state` to a direct `step()` call for any input sequence — proving the wrapper adds nothing on the legacy case.

### 2.5 Occupancy — a richer set source, not a new primitive (R3, R4, R9)

The brief's keystone: occupancy is a **derived predicate** swapped into the `aspectAt` source set, **never stored**. The cascade (route.ts:243-249) is untouched.

**Block granularity (D3): a block is a whole edge.** This is the minimal choice that makes a passing loop and a junction interact, and it maps one-to-one onto the existing per-edge signal model. We do **not** introduce sub-interval blocks or a new "block signal" kind in increment 1 — the **station-starter cascade is overlaid**, not replaced.

```ts
/** Edges with NO train on them — the "clear ahead" set, derived fresh each tick. */
export function blocksClearAhead(graph: TrackGraph, positions: TrainPosition[]): ReadonlySet<string> {
  const occupied = new Set(positions.map((p) => p.edgeId));
  const clear = new Set<string>();
  for (const id of Object.keys(graph.edges)) if (!occupied.has(id)) clear.add(id);
  return clear;
}
```

**How it holds the follower (R3).** A signal protects the *entry to an edge*. `aspectAt` already shows RED iff the protected name is **not** in the `served`-style source set (route.ts:246). We extend the source from `served` (station names) to `served ∪ blocksClearAhead` (station names ∪ clear edge ids), and the protecting signal's `protects` field names **either** the booked station **or** the edge it guards. An edge with a train on it is **absent** from `blocksClearAhead` ⇒ its protecting signal is held RED by the **unchanged cascade** ⇒ the follower holds. The follower is exactly "the player occupying a block ahead delays the AI" and its mirror — neither is a new mechanism; both are a **richer set membership**.

**How it releases (R4, the latch contract).** `blocksClearAhead` is **recomputed from live `TrainPosition`s every tick** and never persisted — structurally identical to how AWS reasons are re-folded fresh each tick (aws.ts:264, "re-derived fresh from the fold … releasable the same tick the source stops demanding them"). The moment the leader's `TrainPosition.edgeId` advances off a block, that edge re-enters `blocksClearAhead`, the protecting signal clears, and the follower's `aiInputs` sees green next tick. **Nothing touches the penalty release machine (controls.ts:284-288):** occupancy lives entirely in the *aspect source set*, upstream of `tickSafety`. For the AI (which has no penalty latch — D7) the hold is purely "target speed → 0 because the aspect ahead is RED"; releasing is "aspect goes green → target speed rises". The mandated empty-set release rule is untouched because occupancy never enters `penaltyReasons`.

**Cascade preserved (R3).** Because `aspectAt` is called with the enriched set but is **otherwise byte-identical**, the R→Y→YY→G rungs and the strictly-increasing-index termination proof (route.ts:241) survive verbatim. **O-OCC-CASCADE** asserts a 3-signal chain still walks R→Y→YY→G with occupancy as the held-red source, exactly as the held-station tests do today.

### 2.6 The AI controller — read-aspect-and-obey (R8)

`aiInputs` is pure and produces the **same `SimInputs`** the player's `resolveInputs` does, so it plugs in at the **exact same boundary** (controls.ts:221) and feeds the **same `step()`**:

```ts
export function aiInputs(
  edge: Edge, state: SimState, dir: 1, aspectAhead: Aspect,
  distToSignal: number, mu: number,
): SimInputs;
```

It computes a **target speed** = `min` of:
1. **PSR ahead** — `speedLimitAt(edge.route, s)` and the next lower posted limit within braking distance (look-ahead on the edge's own profile).
2. **The signal braking curve** — for a RED aspect ahead at distance `Δ`, the curve `v = sqrt(2·a_service·max(Δ − margin, 0))` so the AI brakes to a stand short of the red; YELLOW caps at the medium curve; GREEN/none imposes no signal cap.
3. **Booked-path constraint** — the current edge's posted limit (and, near a booked stop, a stop target).

Then it picks `notch`/`brake` by a simple proportional law toward the target (power below target, coast near it, brake above it), emitting the standard `{notch, brake, dir, mu, emergency:false}`. **No AWS magnets, no DSD, no penalty latch** on AI trains (D7): the AI *reads the aspect and obeys*, which is sufficient for "the player can hold the AI at a red". This is the minimal fidelity that satisfies the requirement; platform dwell / timetable is a clean later extension (the target-speed `min` simply gains a fourth term).

**O-AI-TRACK:** on a clear road the AI converges to and holds the PSR (within tolerance) and never exceeds it. **O-AI-STOP:** facing a RED at distance Δ, the AI reaches a stand with `s < signalChainage` (brakes short of the red — never a SPAD).

### 2.7 The multi-train tick — order-independent (R5)

The per-train record:

```ts
interface TrainRecord {
  id: string;
  pos: TrainPosition;
  state: SimState;
  path: Path;
  kind: "player" | "ai";
  // player only: controls, safety, aws (unchanged Phase-1/2 records)
}
```

One tick (pure, in `multitrain.ts` / `tickGraphWorld`):

```
1. occupancy  ← blocksClearAhead(graph, trains.map(t => t.pos))        // frame-N, ALL trains
2. for each train (iterate in FIXED trainId order — D5 tie-break):
     aspectAhead ← aspectAt(currentSignal, served ∪ occupancy-as-set)
     inputs ← player ? resolveInputs(...) : aiInputs(edge, …, aspectAhead, …)
     { pos, state } ← stepOnGraph(spec, graph, path, t.pos, t.state, inputs, dt)
3. return the new TrainRecords
```

**Determinism (R5).** Occupancy is derived **once, from frame-N positions, before any train steps** — so the result is independent of the order trains are stepped in (preserving the advance-first-then-signal discipline of main.ts:124-129 at the world level: signals are read from the *prior* frame's positions, then everyone advances). The **fixed `trainId` total order** is the tie-break for the one genuinely contended case: two trains booked onto the **same** next edge in the same tick. The lower `trainId` is granted; the other sees its protecting signal RED (the grantee now occupies the block) and holds. This is deterministic and replayable. New modules are pure and dt-/position-driven; **G3 covers them automatically** (it greps all of `src/sim/*.ts`).

**O-DET (replay oracle):** running the testbed scenario twice from the same seed with the same scripted player inputs yields **identical** `TrainRecord` sequences tick-for-tick.

### 2.8 Render — AI trains as world objects (R10)

AI trains are **new meshes positioned by the existing primitive** the lineside furniture already uses (scene.ts:532, 632, etc.):

```ts
// src/render/trains.ts (NEW, impure adapter)
const p = placeOnCentreline(edge.route, aiPos.s, 0, edge.frame); // world point + heading
mesh.position.set(p.x, p.y, p.z);
mesh.rotation.y = p.heading + Math.PI;   // render-side facing offset (D21, existing convention)
```

The player camera stays single-train (it follows the player's `TrainPosition` exactly as it follows `chainage` today, now with the player edge's `frame`). **O17 / O-LAYER:** `src/render/trains.ts` imports only `centerline` (the spatial core) and graph **types** — the sim modules (`graph.ts`, `occupancy.ts`, `ai.ts`, `multitrain.ts`) import **no** render and **no** `centerline` *runtime* beyond what they already may (occupancy/ai/stepOnGraph use only `route`/`simulation`/`graph` types, never `centerline`/`terrain`/`camera`), so the existing O17 import-boundary guard extends cleanly to the new sim files.

---

## 3. File-level impact map

Respecting **G3** (no banned tokens under `src/sim/*.ts` + `render/quality.ts`), **O17** (physics path imports no spatial core), and the **pure/impure split** (`main.ts` is the untested shell with no logic).

### NEW — pure, tested (`src/sim`, G3-clean)
| File | Why |
|---|---|
| `src/sim/graph.ts` | `Edge`, `EdgeFrame`, `IDENTITY`, `Node`, `TrackGraph`, `TrainPosition`, `Path`, `exitFrame`, `nextEdge`, `stepOnGraph`, and the **testbed graph data**. The one home for graph topology + the residual carry (R1, R7). |
| `src/sim/occupancy.ts` | `blocksClearAhead` — the derived, never-stored occupancy set (R3, R4). Imports `graph` types only. |
| `src/sim/ai.ts` | `aiInputs` — the read-aspect-and-obey target-speed tracker (R8). Imports `route`/`simulation` types + `aspectAt` math; **no** spatial core. |
| `src/sim/multitrain.ts` | `tickGraphWorld` (or `tickMultiTrain`) — the order-independent N-train tick + the fixed-`trainId` tie-break (R5). |

### CHG — pure, tested
| File | Change | Why |
|---|---|---|
| `src/sim/centerline.ts` | Add optional trailing `frame: EdgeFrame = IDENTITY` to `planarPoseAt`, `heightAt`, `headingAt`, `centerlineAt`, `placeOnCentreline`; `cantAt` unchanged. **Default path byte-identical** (R2). | The keystone origin-parameterisation. |
| `src/sim/route.ts` | **No signature change.** Optionally widen `Signal.protects` documentation to note it may name an *edge id* (occupancy block) as well as a station; `aspectAt` already takes an arbitrary `ReadonlySet<string>`, so **no code change** is needed there. | `aspectAt` already accepts the enriched set; the only "change" is which strings the scenario puts in `protects` and in the source set. |
| `src/sim/simulation.ts` | **UNCHANGED.** `step()` is not touched (D2). | The tested kernel stays frozen; `stepOnGraph` wraps it. |

### CHG — impure adapters (`src/render`, exempt from G3)
| File | Change | Why |
|---|---|---|
| `src/render/scene.ts` | Accept the player edge's `frame` when calling `placeOnCentreline`/`centerlineAt`; spawn the AI-train layer. | Camera follows the player's `TrainPosition`; world places AI trains. |
| `src/render/trains.ts` (NEW) | AI-train meshes via `placeOnCentreline(edge.route, s, 0, edge.frame)` (R10). | Same primitive as lineside furniture; O17/O-LAYER safe. |

### CHG — the untested shell
| File | Change | Why |
|---|---|---|
| `src/main.ts` | Replace the single `(state, controls, safety, aws)` with `TrainRecord[]`; call `tickGraphWorld` instead of the inline `reduceControls→resolveInputs→step` chain; pass AI positions to render. **No new arithmetic** — every branch is in a pure module. | The shell stays logic-free (the O17/pure-impure contract). |

### NEW — tests (`test/`)
| File | Oracles |
|---|---|
| `test/graph.test.ts` | O-IDENT, O-G1, O-G2, O-EDGE-INV, O-CARRY, O-STEP-PARITY |
| `test/occupancy.test.ts` | O-OCC-HOLD, O-OCC-RELEASE, O-OCC-CASCADE, O-OCC-LOOP |
| `test/ai.test.ts` | O-AI-TRACK, O-AI-STOP |
| `test/multitrain.test.ts` | O-DET, O-TIE, O-SCENARIO (the §4 end-to-end testbed) |
| `test/world.test.ts` (CHG) | Extend O17 to assert `graph.ts`/`occupancy.ts`/`ai.ts`/`multitrain.ts` import no `centerline`/`terrain`/`camera` *runtime* (O-LAYER). |

The G3 guard (signalling.test.ts:994) already globs `src/sim/*.ts`, so the four new sim files are covered with **no test edit**.

---

## 4. Acceptance criteria (definition of done) + the first testbed

### 4.1 The testbed graph

A small graph with exactly the three required features. All edges satisfy the per-edge invariants (R≥250, O-RIBBON, κ=0 bands where structures sit, cant-off-ceiling PSR). Frames are authored so every booked hand-off is C0/G1 continuous.

```
              ┌────────────── E_LOOP (passing loop, parallel running line) ──────────────┐
              │                                                                            │
 ●───E_MAIN1──N1──────────────── E_MAIN2 (through line) ───────────────N2───E_MAIN3───────● Eastbank (buffer stop)
 Westford     │                                                         │
              │                                                         └──N2─E_BRANCH──● Branchend (buffer stop)
              (N1 = loop/main divergence)                               (N2 = branch junction)
```

- **`E_MAIN1`** — `EdgeFrame = IDENTITY`, straight then a gentle curve, length ~1500 m, one starter near its end. Ends at node **N1**.
- **`E_MAIN2`** (through) and **`E_LOOP`** (passing loop) — **two distinct edges** sharing entry node N1 and exit node N2 (D8: the loop is its own edge, **not** a `d`-offset). `E_LOOP` bows aside (κ within R≥250) to run parallel, rejoining at N2. Each is its own occupancy block, each protected by a starter at N1.
- **`E_MAIN3`** (through to Eastbank terminus, buffer-stop edge — `nextEdge` null, so `step()`'s end-clamp stands) and **`E_BRANCH`** (diverges at **N2** to a branch terminus). The junction at N2 books the player onto `E_MAIN3` and the AI onto a route that uses the loop.
- A starter signal at **N1** protects entry to `E_MAIN2`; its `protects` set membership is the **edge id `E_MAIN2`** (occupancy) — so a train on `E_MAIN2` holds it RED.

### 4.2 The scenario (one AI service the player can hold at red)

- **Player** booked `[E_MAIN1, E_MAIN2, E_MAIN3]` (the through line to Eastbank).
- **One AI service** booked `[E_MAIN1, E_LOOP, …]` *or* the **follower** scenario: the AI is booked the **same through line behind the player** `[E_MAIN1, E_MAIN2, E_MAIN3]`. **The decisive test:** the player dawdles on `E_MAIN2` (occupies the block ahead of the AI). The starter at N1 protecting `E_MAIN2` is held **RED** because `E_MAIN2 ∉ blocksClearAhead`; the AI's `aiInputs` reads RED and **brakes to a stand short of N1**. When the player clears `E_MAIN2` (advances onto `E_MAIN3`), `E_MAIN2` re-enters `blocksClearAhead`, the starter clears, and the AI **proceeds** — releasing without any latch being touched. This is the "**player delays the AI by occupying a block ahead**" requirement, end-to-end.

### 4.3 Acceptance oracles (numbered pure test oracles)

1. **O-IDENT** — for ≥200 sampled `s` across `KINGSGATE_SEAHAVEN` and the testbed edges, every geometry function called with `frame = IDENTITY` returns **bit-identical** output to the legacy no-frame call; `cantAt` is frame-invariant. The existing `centerline.test.ts` passes **unchanged**.
2. **O-G1** — for every authored node hand-off in the testbed, `exitFrame(parent)` equals `child.frame` within 1e-6 in `(x0,z0,h0,psi0)`.
3. **O-G2** — sampling either side of each node join, world position and heading are continuous (C0 in position, G1 in tangent) within 1e-6.
4. **O-EDGE-INV** — every edge satisfies the per-route invariants: `minCurveRadius(edge.route) ≥ 250`; any terrain-rendered edge has ribbon half-width ≤ 0.5·minR; structure bands lie on κ=0; every curve's PSR keeps cant ≤ CANT_MAX. A graph-level check folds the per-edge results.
5. **O-CARRY** — a train driven through N1/N2 at a chosen speed lands on the child edge at `s = residual`, with **continuous world pose** (no jump, O-G1) and **invariant** speed/brakeActual/time across the carry.
6. **O-STEP-PARITY** — on a single-edge graph, `stepOnGraph` output is **bit-identical** to a direct `step()` call for a fixed input sequence (the wrapper is a no-op on the legacy case).
7. **O-OCC-HOLD** — with a train on `E_MAIN2`, the N1 starter protecting `E_MAIN2` is **RED** (`E_MAIN2 ∉ blocksClearAhead`); with `E_MAIN2` empty it is GREEN/Y/YY per the cascade.
8. **O-OCC-RELEASE** — after the occupying train advances off `E_MAIN2`, the **same tick** the starter is no longer RED (occupancy re-derived fresh; nothing stored, no latch touched).
9. **O-OCC-CASCADE** — a 3-signal chain with occupancy as the held-red source walks R→Y→YY→G exactly as the held-station cascade does (route.ts proof reused).
10. **O-OCC-LOOP** — a train on `E_LOOP` does **not** occupy `E_MAIN2` (distinct edges/blocks — D8); the two starters are independent.
11. **O-AI-TRACK** — on a clear road the AI converges to and holds the PSR within tolerance and never exceeds it.
12. **O-AI-STOP** — facing a RED at distance Δ, the AI reaches a stand with `s < signalChainage` (brakes short — never a SPAD).
13. **O-TIE** — two trains booked onto the same next edge in one tick: the lower `trainId` is granted the block; the other holds (deterministic).
14. **O-DET** — the testbed scenario run twice from the same seed + scripted player inputs yields **identical** `TrainRecord` sequences tick-for-tick.
15. **O-SCENARIO** — the §4.2 end-to-end: player dawdles → AI held at a stand short of N1 (RED) → player clears `E_MAIN2` → AI proceeds. Asserted on the full multi-train tick.
16. **O-LAYER / O17** — `graph.ts`/`occupancy.ts`/`ai.ts`/`multitrain.ts` import no `centerline`/`terrain`/`camera` runtime; the existing 164 tests + G3 pass unchanged.

**Definition of done:** all 16 oracles green; `npm run check` (tsc --noEmit + vitest) clean; the 164 existing tests pass **unchanged**; `npm run build` (incl. `check-dist`) clean; no banned token under the pure layer.

---

## 5. Residual risks

- **RR1 — reverse running across a node** is deliberately out of scope for increment 1 (the carry is forward-only, `dir===1`). If a later scenario books a reverse hand-off, the symmetric backward carry is a clean, separately-tested addition (mirror of `stepOnGraph`'s while-loop onto the *previous* booked edge). Flagged, not built.
- **RR2 — whole-edge block granularity** can be coarse: a long edge with a train at its far end still holds the whole block. Acceptable for the testbed (edges are sized so blocks are meaningful); sub-interval blocks are a later refinement that slots into `blocksClearAhead` (return a set of `edgeId:interval` keys) without changing the cascade.
- **RR3 — AI without a braking penalty** could, with a pathological PSR/curve combination, momentarily overshoot a target before correcting. O-AI-TRACK/O-AI-STOP bound this; if it bites, the proportional law gains a service-brake floor — still no penalty latch.
- **RR4 — multi-edge dt carry** (a very large `dt` crossing two nodes in one tick) is handled by the `while` loop, but `dt` is clamped to 0.05 s upstream, so in practice at most one node is crossed per tick. O-CARRY exercises the single-node case; a unit test covers the rare two-node `dt`.
- **RR5 — authored-frame drift** (a hand-edited `child.frame` that no longer matches `exitFrame(parent)`) is caught at test time by O-G1, not at runtime. A future graph-builder could *compute* child frames from `exitFrame(parent)` to make the invariant true by construction; for the small authored testbed, the oracle is sufficient and simpler.

---

## 6. Decision log — the 8 open decisions resolved

| # | Decision | Resolution | Rationale (blast-radius first) |
|---|---|---|---|
| **D1** | **Junction orientation / sign reconciliation** (+ oracle) | **Forward-only, same-sense booked hand-offs.** `child.frame == exitFrame(parent)` ⇒ entry tangent = exit tangent ⇒ `dir`/velocity sign **unchanged**; residual `s' = chainage − parent.length ≥ 0` carries directly. Reverse hand-off deferred (RR1). Oracle **O-CARRY** + **O-G1**. | This **designs the hardest risk out of existence**: with same-sense booking there is *no* sign flip to reconcile. Zero new sign logic in the hot path. |
| **D2** | **`stepOnGraph` as a NEW pure layer vs thickening `step()`** | **New pure layer over the UNCHANGED `step()`.** `step()` is frozen; `stepOnGraph` calls it, detects the edge crossing, carries the residual, re-enters `step()`. | Smallest blast radius on the tested kernel: the 164 tests and the dt-slice independence proof touch `step()` and stay green. Thickening `step()` would put graph branches inside the proven integrator — unacceptable. **O-STEP-PARITY** proves the wrapper is a no-op on the legacy case. |
| **D3** | **Block granularity + new signal kind vs overlay** | **Whole-edge blocks; overlay the station-starter cascade (no new signal kind).** Occupancy enriches the `aspectAt` source set (`served ∪ blocksClearAhead`); `protects` may name an edge id. | Reuses the *entire* signalling apparatus — the R→Y→YY→G cascade, the termination proof, the `ReadonlySet<string>` source. No new aspect, no new primitive. Sub-interval blocks are a later, additive refinement (RR2). |
| **D4** | **AI fidelity** (PSR+braking tracker vs +dwell/timetable) | **PSR + braking-curve tracker only** in increment 1. Platform dwell / timetable deferred behind the same `min`-of-targets seam (add a 4th term). | Minimal fidelity that satisfies "player can hold the AI at a red". Dwell/timetable add scope without serving the core requirement; the seam keeps them cheap to add later. |
| **D5** | **Multi-train tick tie-break for block contention** | **Derive occupancy from all frame-N positions first, then step in fixed `trainId` order; lower id wins a contended block.** | Order-independent by construction (signals read prior-frame positions, then everyone advances — the main.ts:124-129 discipline lifted to the world). A fixed total order makes the one contended case deterministic and replayable. **O-DET**, **O-TIE**. |
| **D6** | **Node geometry** (pure frame-handoff w/ divergence baked into child curvature vs explicit turnout geometry) | **Pure frame hand-off; divergence baked into the child edge's own curvature.** No turnout primitive. | Keeps **all** geometry inside the proven `planarPoseAt` arc math — no second geometry code path to test, no new invariant. The branch/loop is "an edge that curves away," which the existing two-arc hand-rotation proof already covers. **O-G1/O-G2/O-EDGE-INV**. |
| **D7** | **AI signalling** (full AWS/penalty machine vs reduced read-aspect-and-obey) | **Reduced read-aspect-and-obey controller.** `aiInputs` reads the aspect ahead and tracks a target speed; **no** AWS magnets, DSD, or penalty latch on AI. | The player keeps the full Phase-1/2 safety stack via `resolveInputs`; the AI needs only to *obey* signals to interact. This keeps the **latch release contract untouched** for AI (occupancy never enters `penaltyReasons`) and avoids AI penalty-loop stalls. |
| **D8** | **`TrainPosition.d`** (parallel track as a `d`-offset on one edge vs two distinct edges) | **Parallel running track = a DISTINCT edge.** `d` stays a within-edge lateral (gauge / platform side / stagger), exactly as today. | A `d`-offset would couple two independent occupancies onto one chainage — breaking R3/R4 (you couldn't hold one track while the other runs). Distinct edges give each its own occupancy block for free. **O-OCC-LOOP**. |

---

## Appendix — why the tested core survives untouched

| Tested asset | How it stays intact |
|---|---|
| `step()` (simulation.ts:45) | Not edited. `stepOnGraph` wraps it (D2). O-STEP-PARITY. |
| The geometry math (centerline.ts) | Only the integration origin becomes a defaulted `EdgeFrame` parameter; `frame=IDENTITY` is byte-identical (R2). O-IDENT; existing centerline.test.ts unchanged. |
| The two-arc hand-rotation proof (O5b) | **Reused, not re-derived** — an EdgeFrame is the same rigid transform applied at `s=0`. |
| The `aspectAt` cascade + termination proof (route.ts:243) | Not edited. Occupancy is a richer source set, not a new rule (D3). O-OCC-CASCADE. |
| The latch release contract (controls.ts:241-251) | Untouched. Occupancy lives upstream of `tickSafety`, never enters `penaltyReasons` (D7). |
| O17 layering / G3 determinism guards | Extended, not weakened: new sim modules import no spatial core and contain no banned tokens (auto-covered by the existing G3 glob). |
| The 164 existing tests | Pass unchanged: `WESTFORD_EASTBANK`/`KINGSGATE_SEAHAVEN` are single-edge graphs at IDENTITY. |
