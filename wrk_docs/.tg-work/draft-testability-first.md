# HLD — Track Graph & Reactive AI (testability-first draft)

**Author angle:** testability-first — designed *backwards from the oracles*.
**Status:** draft for review. **Scope:** architecture HLD + a concrete,
acceptance-tested first increment. Delivery may phase, but the model below is
coherent as a whole.

The governing idea, stated once: **the tested `(s,d)` core is not rewritten — it
is *parameterised at exactly one point* (its integration origin) and *driven over
an ordered list of edges*.** Every new module is a pure layer that *calls* the
existing functions; none of them edits `centerline.ts`, `simulation.ts`,
`route.ts`, or `controls.ts` beyond the single localised origin generalisation.

---

## 0. Oracles first (the definition of done)

Before any model, here are the acceptance oracles. The model in §2 is chosen so
that **each of these is a clean pure unit test — no GPU, no DOM, no clock.** The
numbered, runnable form is §4; this is the design contract they encode.

- **OG1 — Node continuity.** For every node, the entry frame computed for the
  child edge equals the exit frame computed for the parent edge, in position and
  heading, to `1e-6`. (Generalises the existing two-arc hand-rotation proof
  `centerline.test.ts:188` O5b from "one route, two segments" to "two edges, one
  node".)
- **OG2 — Per-edge geometry identity.** On a single edge with `EdgeFrame =
  identity`, every geometry function (`placeOnCentreline`, `planarPoseAt`,
  `heightAt`, `headingAt`, `centerlineAt`, `cantAt`) returns **byte-identical**
  results to today's route functions. (The core is unchanged; identity is the
  special case.)
- **OG3 — `stepOnGraph` carry-over.** A train whose `s` crosses `edge.length`
  inside one `dt` continues onto the next booked edge with the residual distance,
  with speed magnitude preserved and orientation/sign reconciled at the junction
  (incl. an orientation *flip* at a reversed node). Total along-path distance
  travelled equals what an equivalent single concatenated route would give, to
  `1e-9`.
- **OG4 — Occupancy ⇒ follower-RED ⇒ follower-holds, and release.** With a lead
  train standing in the block a starter protects, that starter's aspect derived
  over the occupancy set is `RED`; the follower's `aiInputs` commands a braking
  curve that brings it to a stand short of the post; **when the lead clears the
  block, the same predicate stops demanding the hold and the aspect lifts** —
  without touching the latch release machine.
- **OG5 — AI braking curve never overspeeds.** `aiInputs` tracking a target
  speed (min of PSR-ahead, the `v²/2a` red/yellow curve, and booked-path limits)
  never lets the AI train exceed the lower envelope by more than a fixed tick
  tolerance, and stops at/short of a red post.
- **OG6 — Replay determinism.** Same scenario + same scripted input stream ⇒
  identical trajectories for **all** trains, bit-for-bit, run-to-run and across
  any dt-slicing that respects `dt ≤ 0.05` for steady intervals (dt-slice
  independence, the existing physics property).
- **OG7 — Per-edge invariants + graph oracle.** Every edge independently
  satisfies `minCurveRadius ≥ 250`, O-RIBBON (`ribbonHalfWidth ≤ 0.5·minR`),
  band-on-`κ=0`, and cant-off-ceiling PSR; **and** the graph as a whole is
  well-formed (every `Path` edge id exists; every interior node's parent/child
  frames satisfy OG1; no path references a missing block).
- **OG8 — Multi-train tick order-independence.** Deriving occupancy from all
  trains' frame-N positions and *then* stepping every train yields a result
  independent of the order trains are listed; block contention resolves by a
  single deterministic tie-break (§2.6).
- **OG9 — Layering + determinism guards still hold.** G3 (no clock/random in
  `src/sim/*.ts` + `render/quality.ts`) and O17 (sim never imports the spatial
  core) pass with the new modules added.

---

## 1. Scope & non-goals

### In scope
- A **TrackGraph**: nodes (points/junctions) + edges, with alternate routes (a
  through line, a passing loop, a junction to a branch).
- A **booked route per train** (`Path` = ordered edge list) the *scenario* fixes.
  The player follows a booked route that may diverge onto a branch or be looped
  to be passed. **No manual point-setting, no interlocking UI, no runtime
  pathfinding** — the path is *data*.
- **Multiple deterministic trains**: one player (keeps `resolveInputs`) and ≥1
  reactive-AI services (use a new pure `aiInputs`). All feed the **unchanged**
  `step()`.
- **Occupancy-driven signalling**: a *derived* predicate over all trains'
  positions makes a protecting signal `RED` so a follower holds — the player can
  thereby delay an AI by sitting in the block ahead.
- **AI trains rendered as world objects** via the existing `placeOnCentreline`
  primitive.
- The first increment: a concrete testbed graph + scenario whose acceptance run
  is the definition of done (§4.10).

### Non-goals (this HLD)
- No interlocking/route-setting UI, no signaller's panel, no dynamic
  re-pathing. Points are scenario data.
- No timetable engine / platform-dwell choreography in increment 1 (AI is a
  speed-and-safety tracker; dwell is a deferred, additive `Path` annotation —
  D4).
- No multiplayer, no network, no save/load.
- No rewrite of physics, controls, the AWS/penalty machine, or the geometry
  kernel. We extend at named seams only.
- No backwards-compat / migration shims (dev sandbox). The single existing route
  becomes the degenerate one-edge graph; we do not keep a parallel scalar path.

---

## 2. The design

### 2.0 The seam map (where each thing plugs in)

| Concern | Tested origin (unchanged) | New pure layer that *calls* it |
|---|---|---|
| Geometry math | `centerline.ts` functions | `Edge` wraps a `Route` + `EdgeFrame`; origin generalised |
| Position | `SimState.chainage` (scalar) | `TrainPosition {edgeId,s,d}` |
| Advance | `step()` `simulation.ts:45` | `stepOnGraph()` — thin wrapper, carries residual across nodes |
| Aspect | `aspectAt(route,i,served)` `route.ts:243` | occupancy predicate broadens the source `Set` |
| Player inputs | `resolveInputs` `controls.ts:221` | unchanged for the player |
| AI inputs | (n/a) | `aiInputs(...)` → same `SimInputs` shape |
| Tick wiring | `main.ts:122-129` order | per-train records; same advance-then-signal order |
| Render | `placeOnCentreline` | AI meshes from the same primitive |

The two load-bearing invariants we never break: **the geometry kernel changes in
exactly one place** (the integration origin), and **`step()`'s body is
untouched** (`stepOnGraph` is a layer *over* it, D2).

---

### 2.1 `EdgeFrame` — parameterising the integration origin

Today `planarPoseAt` (`centerline.ts:90-94`) hard-wires the integration origin:

```ts
let x = 0;
let z = 0;
let psi = 0; // ψ₀ = 0 at s=0
```

`heightAt` likewise integrates grade from a `y=0` datum. **The only change to the
kernel is to lift these three constants `(x0, z0, ψ0)` — plus a height datum
`y0` — out of the function body into a frame parameter.**

```ts
/** The integration origin handed to an edge: where its s=0 sits and how its
 *  entry tangent is rotated, in world coordinates. EdgeFrame.identity reproduces
 *  today's hard-wired psi=0,(0,0),0 — so a single route is the special case. */
export interface EdgeFrame {
  x0: number;   // world X of the edge's s=0
  z0: number;   // world Z of the edge's s=0
  y0: number;   // world Y datum at s=0 (heightAt accumulates from here)
  psi0: number; // entry heading (rad); rotates the edge's local arc displacement
}

export const IDENTITY_FRAME: EdgeFrame = { x0: 0, z0: 0, y0: 0, psi0: 0 };
```

**How the kernel generalises (concrete, minimal):** the existing accumulation in
`planarPoseAt` is already *relative* — each segment rotates its local arc
displacement by the running `psi` and adds it (the O5b proof). Starting `psi` at
`psi0` instead of `0`, and adding `(x0,z0)` to the accumulated `(x,z)`, is
**exactly a rigid hand-rotation of the whole edge by `psi0` then a translate by
`(x0,z0)`** — the same transform O5b already validates for the *second arc*. We
do not re-derive any math; we feed it a non-identity start.

We add **one** new pure function rather than editing every call site:

```ts
/** placeOnCentreline / planarPoseAt / heightAt / headingAt etc., evaluated on an
 *  Edge: compute in the route's LOCAL frame (the existing functions, untouched),
 *  then apply the edge's rigid frame. Local→world is a 2-D rotation by psi0 +
 *  translate by (x0,z0); height adds y0; headings add psi0. */
export function poseOnEdge(edge: Edge, s: number, d: number): {
  x: number; y: number; z: number; heading: number;
};
```

`poseOnEdge` calls the **unchanged** `placeOnCentreline(edge.route, s, d)` to get
the local pose, then:

```
worldX = x0 + cos(psi0)*localX + sin(psi0)*localZ
worldZ = z0 - sin(psi0)*localX + cos(psi0)*localZ   // rotate by psi0 (Z-up plane)
worldY = y0 + localY
worldHeading = psi0 + localHeading
```

This is the **byte-identical** path (OG2): with `IDENTITY_FRAME` the rotation is
identity, `y0=0`, `psi0=0`, so `poseOnEdge ≡ placeOnCentreline`. We assert that
equality as a test rather than trust it.

> **Decision (D6):** node geometry is **pure frame hand-off with divergence baked
> into the child edge's own curvature profile** — *not* explicit turnout geometry.
> A diverging branch is just a child `Edge` whose first curvature segment bends it
> away; the node only hands over the frame. This keeps every node a rigid
> transform (testable by OG1) and reuses the entire kernel. Rationale below (§6).

`cantAt` and `speedLimitAt` are functions of the *route's local s* only — they are
frame-invariant and need **no** change. `heightAt` gains `y0` via `poseOnEdge`'s
`+y0`; the route-local `heightAt` is unchanged.

---

### 2.2 `Edge` — a route restricted to one node-to-node span

```ts
/** A node-to-node span. Geometrically it IS a Route (length + grades +
 *  speedLimits + curvatures + its own signals + optional viaducts/tunnels/
 *  terrainSeed) — so EVERY centerline function already works on it — plus the
 *  EdgeFrame that places its s=0 in the world. */
export interface Edge {
  id: string;
  route: Route;          // the existing per-span 1-D data; ALL geometry math reuses it
  frame: EdgeFrame;      // integration origin (identity for the legacy single route)
  fromNode: string;
  toNode: string;
  blocks: BlockId[];     // see §2.5 (whole-edge granularity in increment 1)
}
```

An `Edge.route` is authored exactly like `WESTFORD_EASTBANK` /
`KINGSGATE_SEAHAVEN` today — same shape, same per-route invariants (now checked
**per edge**, OG7). The legacy single route becomes one edge with
`frame = IDENTITY_FRAME`; nothing about its tests changes.

---

### 2.3 `TrackGraph` & `Node`

```ts
/** A node = a shared frame where edges meet. A point/junction is a node with one
 *  parent edge and ≥2 child edges; the scenario's Path selects which child. */
export interface Node {
  id: string;
  /** The world frame at this node (an exit frame of a parent edge). Optional —
   *  if omitted, derived from the parent edge's exit pose during validation. */
  frame?: EdgeFrame;
}

export interface TrackGraph {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
}
```

**Continuity is a derived oracle, not a stored assumption.** For each edge,
`exitFrame(edge)` is `poseOnEdge(edge, edge.route.length, 0)` expressed back as an
`EdgeFrame`; `entryFrame(edge)` is `edge.frame`. The graph is *well-formed* iff
for every node, every child's `entryFrame` equals the parent's `exitFrame` to
`1e-6` in `(x,z,heading)` (OG1). Authoring computes child `frame`s **by composing
the parent's exit frame** (so they agree by construction); the oracle catches any
hand-authored slip.

A **buffer-stop edge** is an edge whose `toNode` has no outgoing edge in any
`Path`. The existing end-clamp (`simulation.ts:88-91`, `speed=0` at
`route.length`) **survives only there** — `stepOnGraph` overrides the clamp on any
edge that has a booked successor (§2.4).

---

### 2.4 `TrainPosition` & `stepOnGraph`

```ts
/** Replaces SimState.chainage. d = lateral track offset (parallel tracks live as
 *  distinct edges, NOT a d-offset — see D8; d stays 0 for the train centreline
 *  and is reserved for render furniture, exactly as placeOnCentreline uses it). */
export interface TrainPosition {
  edgeId: string;
  s: number;   // chainage along THIS edge (the scalar step() already integrates)
  d: number;   // lateral offset; 0 for the running rail centreline
}

/** Per-train sim record: the existing SimState scalar split into (edgeId, s) plus
 *  the unchanged dynamic fields. */
export interface TrainSim {
  pos: TrainPosition;
  speed: number;       // m/s, signed — unchanged semantics
  brakeActual: number; // unchanged
  time: number;        // unchanged
}
```

> **Decision (D2):** `stepOnGraph` is a **NEW pure layer over the UNCHANGED
> `step()`**, not a thickened `step()`. `step()` keeps its scalar `(chainage,
> speed, …)` contract and its entire test suite. `stepOnGraph` *calls* `step()`
> with the current edge's `route` and the train's `s` as the chainage, inspects
> the returned chainage, and — **only when it crosses `edge.length` with a booked
> successor** — re-invokes `step()` on the next edge with the residual.

The wrapper is the single most error-prone seam (junction sign/orientation), so
it is small, explicit, and oracle-pinned (OG3):

```ts
export function stepOnGraph(
  spec: TrainSpec,
  graph: TrackGraph,
  path: Path,              // this train's booked route (ordered edge ids)
  ts: TrainSim,
  inputs: SimInputs,
  dt: number,
  occupancy: Occupancy,    // derived this tick (§2.5)
): TrainSim;
```

**Carry-over algorithm (one hop max per sub-concern; loop guards multi-hop):**

1. Build a scalar `SimState {chainage: ts.pos.s, speed, brakeActual, time}` and
   call the **unchanged** `step(spec, edge.route, scalar, inputs, dt)`.
2. If the returned `chainage` is within `[0, edge.length]` (or this is a
   buffer-stop edge), write it straight back — **identical to today** for the
   single-edge case (OG2 extends to dynamics: a one-edge path reproduces current
   behaviour).
3. If `chainage > edge.length` and the path has a successor edge `next`:
   - `residual = chainage - edge.length` (distance into the next edge).
   - **Orientation/sign reconciliation (D1):** the node records whether `next` is
     entered at its `s=0` end (forward) or its `length` end (reversed —
     e.g. a loop where the train comes back the other way). A per-`Path` boolean
     `reversed[next]` (scenario data, validated against frames) sets the new `s`
     and flips `speed`/`dir` sign iff reversed:
     - forward: `s' = residual`, `speed' = speed` (sign unchanged).
     - reversed: `s' = next.length - residual`, `speed' = -speed`, and the
       train's `dir` authority flips — `aiInputs`/`resolveInputs` read `dir` from
       the train record, so a single sign field carries it.
   - Recurse with the residual carried as the new `dt`-equivalent advance (in
     practice clamp: at `dt ≤ 0.05` and realistic speeds a train crosses at most
     one short edge per tick; the loop guards the pathological case and the
     **oracle OG3 pins the residual arithmetic exactly**).
4. Backward crossing (`chainage < 0`, train reversing past the edge start) is the
   mirror, hopping to the predecessor edge.

**The orientation oracle (OG3, D1's proof):** concatenate two edges into one
synthetic single `Route` whose curvature/grade/speed segments are the two edges'
profiles laid end to end. Drive a train across the boundary on the graph and on
the concatenated route with identical inputs; assert the world poses
(`poseOnEdge` vs `placeOnCentreline`) and the cumulative distance agree to
`1e-9`. For the reversed-node case, the synthetic route reverses the second
edge's profile and the test asserts the sign flip lands the train at the mirror
position. This is a pure differential test — no clock, no GPU.

---

### 2.5 Occupancy & the aspect cascade

> **Decision (D3):** block granularity is **whole-edge** in increment 1, and
> occupancy **overlays the existing station-starter cascade — it does NOT add a
> new signal kind.** A block is named by an edge (or a coarse sub-span id later);
> a starter that today is held `RED` by an unserved station is *also* held `RED`
> when the block it protects is occupied. The R→Y→YY→G cascade and its
> strictly-increasing-index termination proof (`route.ts:243-253`) are untouched.

The mechanism is exactly the one the brief names: **a richer source set, not a
new primitive.** Today:

```ts
if (!served.has(sig.protects)) return "RED"; // route.ts:247 — OWN held-red first
```

We derive a set of *clear* tokens and pass the **union** of `served` and
"blocks-clear-ahead" into the existing `aspectAt`:

```ts
/** DERIVED, never stored: the set of block ids currently occupied by ANY train,
 *  computed from all TrainPositions at frame N. O(trains). */
export type Occupancy = ReadonlySet<BlockId>;

export function occupancyOf(positions: TrainPosition[]): Occupancy; // pure fold

/** The aspect source for a signal: the station-served tokens UNION the
 *  "protected block is clear" tokens. Plugs straight into aspectAt's `served`
 *  parameter — the cascade code does not change, only what we hand it. */
export function aspectSource(
  servedStations: ReadonlySet<string>,
  occupancy: Occupancy,
  edge: Edge,
): ReadonlySet<string>;
```

`aspectSource` returns a set containing each station name in `servedStations`
**and** a synthetic token for each protected block that is *clear* (`!occupancy.
has(block)`). The starter's `protects` field is generalised to name either a
station or a block token; `aspectAt`'s `served.has(sig.protects)` predicate is
**unchanged** — it just now sometimes asks about a block token. A lead train in
the block ⇒ token absent ⇒ `RED` ⇒ follower holds (OG4).

**Release (the latch contract, D7):** occupancy is *re-derived every tick* from
live positions — it is never latched. When the lead clears the block, the token
re-appears in the source set, the aspect lifts, and the follower's `aiInputs`
stops commanding the brake. This is precisely the brief's "a persisting hold
re-adds itself by failing a *source no longer demands it* predicate **without
touching the release machine**" — except occupancy holds need no machine at all,
because they are stateless derivations. The AWS/penalty latch
(`controls.ts:252-291`) is left exactly as-is; occupancy never enters it.

---

### 2.6 The AI controller `aiInputs`

> **Decision (D4):** AI fidelity = **a PSR + braking-curve target-speed tracker**
> (no platform dwell / timetable) in increment 1. Dwell/timetable is a deferred
> additive `Path` annotation (§5). **Decision (D7):** the AI is a **reduced
> read-aspect-and-obey controller**, not the full AWS/penalty machine. The AI
> reads the next signal's aspect (via the occupancy-broadened `aspectAt`) and
> obeys it directly; it never accrues DSD/AWS penalties (those model a *human*
> driver's vigilance, irrelevant to a deterministic service).

```ts
/** Pure: produce the SAME SimInputs {notch,brake,dir,mu,emergency} resolveInputs
 *  produces, so it plugs in at the EXACT resolveInputs boundary. A target-speed
 *  tracker: target = min(PSR ahead, red/yellow braking curve v²/2a, booked-path
 *  constraints). No DOM, no clock — advances only off dt-driven state. */
export function aiInputs(
  spec: TrainSpec,
  graph: TrackGraph,
  path: Path,
  ts: TrainSim,
  aspectAhead: Aspect,        // from aspectAt over aspectSource (§2.5)
  distanceToTarget: number,   // m to the protecting post / PSR change ahead
  mu: number,
): SimInputs;
```

**Target speed** is the minimum of three pure quantities, all read from edge
data the kernel already exposes:

1. **PSR ahead** — `speedLimitAt(edge.route, s_ahead)` over the booked path
   (lookahead spans edge boundaries by walking `path`).
2. **Signal braking curve** — for `RED`: `vₜ = √(2·a_service·max(0, distance −
   margin))` so the train reaches `0` a margin short of the post; for `YELLOW`/
   `DOUBLE_YELLOW`: track the next *posted* limit / be prepared to stop at the
   following red, the same `v²/2a` form. `GREEN` imposes no signal constraint.
3. **Booked-path constraints** — the edge's own PSR and the line speed.

The controller is a proportional notch/brake selector around the target (power
when below target with margin, coast in the band, service brake when above), with
the **same `SimInputs` fields** the physics already consumes. It never reaches
into `step()`; it only produces inputs. **OG5** pins "never overspeeds the
envelope, stops at/short of red."

`dir` comes from the train record (set by `stepOnGraph`'s reconciliation), `mu`
from the environment, `emergency=false` for the AI (a service brake is enough;
emergency is a human/penalty affordance). The player path is unchanged:
`resolveInputs` still drives the player.

---

### 2.7 The multi-train tick

> **Decision (D5):** the tick is **order-independent by construction** (OG8):
> derive occupancy from *all* trains' frame-N positions **first**, then step every
> train on the **shared clamped `dt`**. Block contention (two trains entering the
> same empty block in one tick) resolves by a **single deterministic tie-break:
> lower `path`-index train id wins the block this tick; the loser sees the block
> as occupied and holds.** This preserves the brief's advance-first-then-signal
> ordering at the *frame* boundary (the same shape as `main.ts:124-129`).

The pure per-tick function (the new `main.ts` logic lives here, *not* in the
impure shell):

```ts
export interface WorldState {
  trains: TrainRecord[]; // player at index 0; AI services follow
  servedByTrain: Map<string, ReadonlySet<string>>; // station-served per train (AWS for player)
}

/** One deterministic world tick. Pure. */
export function tickWorld(
  spec: TrainSpec,
  graph: TrackGraph,
  world: WorldState,
  playerInputs: SimInputs,   // from resolveInputs (unchanged player path)
  dt: number,
): WorldState;
```

Sequence (mirrors and generalises `main.ts:122-129`):

1. `occupancy = occupancyOf(all trains' frame-N positions)`.
2. For each train: compute its `aspectAhead` over `aspectSource(served,
   occupancy, edge)`; the player uses `playerInputs`, each AI uses
   `aiInputs(...)`.
3. Apply the contention tie-break to occupancy claims (deterministic order).
4. `stepOnGraph` every train on the shared clamped `dt`.

Because occupancy is read *before* any train moves, and the tie-break is a pure
function of train order, the result is independent of iteration order (OG8).

---

### 2.8 Render — AI trains as world objects

AI trains are **new meshes placed by the same primitive lineside furniture uses**:
`poseOnEdge(edge, s, 0)` → world `(x,y,z)` + heading (the brief's
`placeOnCentreline(edge,s,0)+heading`). The render layer reads each AI
`TrainPosition`, calls `poseOnEdge`, and positions/orients a train mesh — exactly
as scenery already places posts and platforms. **The player camera stays
single-train** (the player's own `TrainPosition` drives the existing camera). No
new render math; render still never imports more of sim than the position types
(O17 holds, OG9).

---

## 3. File-level impact map

Respecting **G3** (no clock/random in `src/sim/*.ts` + `render/quality.ts`),
**O17** (sim never imports `centerline`/`terrain`/`camera`… — note `graph.ts`
*may* import `centerline` because it is part of the **spatial** layer, not the
1-D physics path the O17 guard fences; see note), and the **pure/impure split**
(all logic in `src/sim`, `main.ts` stays logic-free).

### NEW — `src/sim`
| File | Why |
|---|---|
| `src/sim/graph.ts` | `Edge`, `EdgeFrame`, `IDENTITY_FRAME`, `Node`, `TrackGraph`, `poseOnEdge`, `entryFrame`/`exitFrame`, `validateGraph` (OG1/OG7 graph oracle). Imports `centerline` + `route` — it is the **spatial graph layer**, the legitimate consumer of the kernel, *not* part of the O17-fenced physics path. |
| `src/sim/graph-step.ts` | `TrainPosition`, `TrainSim`, `Path`, `stepOnGraph` (D2 — wraps the **unchanged** `step()`). Imports `simulation` only; no `centerline`. |
| `src/sim/occupancy.ts` | `Occupancy`, `occupancyOf`, `aspectSource` (D3). Imports `route` (for `Edge`/`Signal`) only. |
| `src/sim/ai.ts` | `aiInputs` (D4/D7). Imports `route`, `simulation`, `physics`, `graph-step` types; produces `SimInputs`. **No clock/random** (G3). |
| `src/sim/world.ts` | `WorldState`, `TrainRecord`, `tickWorld` (D5/D8). The order-independent multi-train tick; pure. |
| `src/sim/testbed.ts` | The increment-1 graph + scenario data (§4.10) — pure data, the acceptance fixture (analogous to `WESTFORD_EASTBANK`). |

### CHG — `src/sim` (localised, additive)
| File | Change | Why it is not a rewrite |
|---|---|---|
| `src/sim/centerline.ts` | Lift `(x0,z0,ψ0,y0)` into an `EdgeFrame`-style origin. **Minimal:** either (a) keep the existing functions byte-identical and add `poseOnEdge` in `graph.ts` that post-applies the rigid frame (preferred — *zero* edits to `centerline.ts`), or (b) add an optional `frame = IDENTITY_FRAME` param threaded through. **Preferred is (a): `centerline.ts` is untouched; the frame lives entirely in `graph.ts`.** OG2 guarantees identity. |
| `src/sim/route.ts` | `Signal.protects` may name a block token as well as a station (a one-line type/comment widening; `aspectAt`'s `served.has` is unchanged). | Predicate untouched; only the *vocabulary* of the token set grows — exactly "a richer set source, not a new primitive." |

> **Strong preference: option (a).** Keeping `centerline.ts` byte-identical and
> confining the frame to `graph.ts/poseOnEdge` means the geometry kernel's tests
> *cannot* regress and OG2 is trivially true. The brief's "integration origin
> becomes an EdgeFrame" is realised as *post-composition by a rigid frame*, which
> is mathematically the same lift but touches zero tested lines.

### CHG — `src/render`
| File | Change | Why |
|---|---|---|
| `src/render/scene.ts` | Add AI train meshes placed via `poseOnEdge(edge,s,0)`; iterate `WorldState.trains[1..]`. | New world objects via the existing placement primitive; no new math. |

### CHG — impure shell
| File | Change |
|---|---|
| `src/main.ts` | Replace the single-train `step` call with `tickWorld`; build the player's `SimInputs` from the unchanged `resolveInputs`; pass `WorldState`. **No new arithmetic** — every branch lives in `src/sim`. The `dt` clamp + the only `performance.now` stay here. |

### NEW — `test`
| File | Oracles |
|---|---|
| `test/graph.test.ts` | OG1 (node continuity), OG2 (identity equivalence), OG7 (per-edge invariants + graph well-formedness). |
| `test/graph-step.test.ts` | OG3 (carry-over incl. orientation flip; differential vs concatenated route). |
| `test/occupancy.test.ts` | OG4 (occupancy ⇒ RED ⇒ hold ⇒ release). |
| `test/ai.test.ts` | OG5 (braking curve never overspeeds; stops short of red). |
| `test/world.test.ts` (extend) | OG8 (order-independence), and **extend G3/O17 globs** to cover the new sim files (OG9). |
| `test/replay.test.ts` | OG6 (replay determinism; dt-slice independence for the whole world). |

**G3/O17 maintenance (OG9):** the G3 glob (`signalling.test.ts:994`) already
matches `../src/sim/*.ts` by wildcard, so new sim files are auto-covered — we add
a non-vacuity assertion naming them. The O17 glob (`world.test.ts:36`) lists the
*physics-path* modules explicitly; `graph.ts` is deliberately **not** added to
that list because it is the spatial-graph layer (it *may* import `centerline`).
We instead assert the converse: `simulation`/`controls`/`physics`/`aws`/`ai` do
**not** import `centerline`/`terrain`/`camera` — `ai.ts` joins the fenced list, so
the AI controller stays purely 1-D.

---

## 4. Acceptance criteria (numbered pure oracles) + the first testbed

All pure: Node only, no Three.js, no DOM, no wall-clock. Each maps to a test file
above.

1. **OG1 (continuity).** For the testbed graph (§4.10), for every node and every
   booked child edge, `entryFrame(child)` equals `exitFrame(parent)` in
   `(x,z,heading)` to `1e-6`. Positive control: perturb one child frame by `1e-3`
   and assert `validateGraph` rejects it.
2. **OG2 (identity).** For `KINGSGATE_SEAHAVEN` wrapped as one edge with
   `IDENTITY_FRAME`, `poseOnEdge(edge,s,d)` equals `placeOnCentreline(route,s,d)`
   for a sweep of `(s,d)` to `1e-12`; `headingAt`/`heightAt`/`cantAt` likewise.
3. **OG3 (carry-over).** Two edges `A`(straight 400 m) + `B`(curve) joined at a
   node. Driving across the boundary on the graph equals driving the concatenated
   single route, in world pose (`1e-9`) and cumulative distance (`1e-9`). Reversed
   variant: `B` entered at its `length` end flips `speed` sign and lands at the
   mirror `s`; assert position equals the hand-computed mirror.
4. **OG4 (occupancy hold + release).** Lead train standing in block `LOOP`; the
   starter protecting `LOOP` derives `RED` over `aspectSource`; the follower's
   `aiInputs` brings it to a stand short of the post (`speed→0`, `s < post`).
   Move the lead out of `LOOP`; re-derive; aspect lifts to (at least) `YELLOW`;
   the follower's `aiInputs` releases the brake and accelerates. No latch state
   touched (assert `SafetyState` unchanged).
5. **OG5 (no overspeed).** Over a scripted run on a path with a PSR drop and a red
   post, `aiInputs`-driven speed never exceeds `min(PSR, v²/2a-curve)` by more
   than one tick's `a·dt`, and final `s ≤ post − margin` with `speed = 0`.
6. **OG6 (replay determinism).** Run the §4.10 scenario twice with the same
   scripted input stream; assert every train's `(edgeId,s,speed)` trajectory is
   identical array-for-array. Then run once at `dt=1/240` and once at `dt=1/60`
   over a steady interval (`dt ≤ 0.05`) and assert end-states match to `1e-9`
   (dt-slice independence, the existing physics property extended to the world).
7. **OG7 (per-edge + graph invariants).** Every edge: `minCurveRadius(edge.route)
   ≥ 250`; if terrain-rendered, `ribbonHalfWidth ≤ 0.5·minR`; any band on `κ=0`;
   cant-off-ceiling PSR (`0.08·|κ|·v² ≤ 0.105`). Graph: every `Path` edge id
   exists; every interior node passes OG1; every starter's protected block exists.
8. **OG8 (order-independence).** `tickWorld` with `trains` in order `[player,
   ai1, ai2]` equals the result with `[player, ai2, ai1]` for a tick where two AI
   trains contend for one block; the deterministic tie-break (lower path-index
   wins) gives one fixed outcome.
9. **OG9 (guards).** G3 over `src/sim/*.ts` + `render/quality.ts` is green with
   the new files (non-vacuity asserts they were globbed); the O17/`ai.ts` fence
   holds (`ai.ts` imports no spatial core).

### 4.10 The concrete first testbed graph + scenario

A minimal graph that exercises **through line + passing loop + a junction to a
branch** — the smallest shape that makes every oracle meaningful.

**Nodes:** `N0` (entry) — `N1` (loop/junction throat) — `N2` (loop/junction exit)
— `N3` (line end) — plus `NB` (branch terminus).

**Edges** (each `Edge.route` authored like `WESTFORD_EASTBANK`, all `minR ≥
250`):
- `E_main_in`  `N0→N1`  — straight approach, one starter `S0` protecting the
  block ahead.
- `E_main`     `N1→N2`  — the **through** main line past the loop.
- `E_loop`     `N1→N2`  — the **passing loop** (parallel running line as a
  **distinct edge**, D8), a starter `S_loop` at its exit.
- `E_main_out` `N2→N3`  — onward to the line end (buffer-stop edge: end-clamp
  survives here).
- `E_branch`   `N1→NB`  — the **diverging branch** (its first curvature segment
  bends it away, D6), to a buffer-stop terminus `NB`.

**Blocks (whole-edge, D3):** `B_main` = `E_main`, `B_loop` = `E_loop`,
`B_out` = `E_main_out`, `B_branch` = `E_branch`.

**Paths (scenario data — points are pre-set):**
- **Player:** `[E_main_in, E_main, E_main_out]` — the booked through route.
- **AI service "Stopper":** `[E_main_in, E_loop, E_main_out]` — booked into the
  **loop to be passed**. `S_loop` protects `B_out`.

**Scenario / definition of done:** the player runs `E_main_in → E_main →
E_main_out`. The Stopper is booked into `E_loop`. **The player, by occupying
`B_out` (the shared exit block onto `E_main_out`), holds `S_loop` at RED so the
Stopper waits in the loop until the player clears the block — then the Stopper's
`aiInputs` releases and it follows onto `E_main_out`.** This single run
demonstrates: a multi-edge graph with a loop *and* a branch; a deterministic AI
service; occupancy-driven RED that the **player** causes by occupying the block
ahead; release when the player clears; and renderable AI trains. The acceptance
run asserts OG1–OG9 against this fixture.

A **second AI** booked onto `E_branch` exercises the junction-to-branch divergence
and OG8 contention (both AIs reaching `N1` in the same tick — the tie-break
decides).

---

## 5. Residual risks

- **R1 — `stepOnGraph` multi-hop.** If an edge is shorter than a train moves in
  one `dt`, the carry-over recurses. Mitigation: at `dt ≤ 0.05` and ≤ line speed
  this is sub-metre per tick vs hundreds-of-metres edges; the loop guard + OG3
  pin it, but pathological tiny edges are a hazard — author edges ≥ a few car
  lengths. *Open*: cap recursion depth and assert no test hits it.
- **R2 — Orientation-sign authoring.** The `reversed` flag on a loop edge is
  hand-authored data; a wrong flag silently mirrors a train. OG3's reversed
  variant catches it for the testbed, but every new loop needs the differential
  test. Mitigation: make `validateGraph` *derive* the expected `reversed` from the
  frames and reject a contradicting flag (turn the risk into an oracle).
- **R3 — Whole-edge blocks are coarse.** Two trains cannot share a long edge even
  when safely far apart, so capacity is low and a long block can deadlock a
  loop-pass if mis-authored. Acceptable for increment 1; sub-interval blocks
  (D3 future) refine it additively without changing the cascade.
- **R4 — AI tuning vs determinism.** The proportional notch/brake selector must be
  *purely* a function of state (no hysteresis timers off the clock). G3 enforces
  no clock, but a poorly-shaped controller can oscillate; OG5 bounds overspeed but
  not chatter. Mitigation: a band (coast zone) around the target; add an
  anti-chatter oracle if observed.
- **R5 — O17 fence semantics.** `graph.ts` legitimately imports `centerline`,
  which the original O17 guard would flag if naïvely added to the physics-path
  list. We *deliberately* keep it out of that list and fence `ai.ts` instead. Risk
  of confusion; mitigation: a comment in `world.test.ts` stating the spatial-graph
  layer is the sanctioned `centerline` consumer.
- **R6 — Player-as-block-occupant edge cases.** The player can sit *straddling* a
  block boundary; occupancy from a single `TrainPosition` point may under-report.
  Mitigation: in increment 1 a train occupies the block of its current edge
  (point occupancy is exact at whole-edge granularity); train *length* occupancy
  is a future refinement that rides on sub-interval blocks.

---

## 6. Decision log (resolves all 8 open decisions)

- **D1 — Junction orientation/sign reconciliation.** Each `Path` edge transition
  carries a `reversed` boolean (does the train enter the next edge at its `s=0` or
  its `length` end). Forward: `s'=residual`, sign kept. Reversed: `s'=length−
  residual`, `speed`/`dir` sign flipped. **Oracle:** OG3's differential test vs a
  concatenated/mirrored synthetic route (`1e-9`). **Hardened:** `validateGraph`
  *derives* the expected flag from the parent/child frames and rejects a
  contradicting hand-authored flag — the risk becomes a check. *Rationale:* a
  single sign field is the minimal carrier; trains already read `dir` from their
  record, so nothing downstream changes.
- **D2 — `stepOnGraph` as a new layer vs thickening `step()`.** **New pure layer
  over the UNCHANGED `step()`.** `step()` keeps its scalar contract and its whole
  test suite; `stepOnGraph` calls it per edge and handles only the residual carry.
  *Rationale:* the kernel's value *is* its test coverage; thickening it would put
  the most error-prone new logic (junctions) inside the one function we most want
  frozen. The seam is small and independently oracle-pinned.
- **D3 — Block granularity & signal kind.** **Whole-edge blocks; occupancy
  overlays the existing station-starter cascade — no new signal kind.** A starter
  held RED by an unserved station is *also* held RED by an occupied protected
  block; `aspectAt`'s `served.has(protects)` predicate is unchanged, only the
  token set it is asked about grows (station tokens ∪ clear-block tokens).
  *Rationale:* preserves the R→Y→YY→G cascade and its strictly-increasing-index
  termination proof verbatim; "player delays AI by occupying a block" is a richer
  *set source*, exactly as the brief mandates. Sub-interval blocks slot in later
  additively.
- **D4 — AI fidelity.** **PSR + braking-curve target-speed tracker** only (no
  dwell/timetable) in increment 1. Target = `min(PSR ahead, v²/2a red/yellow
  curve, booked-path limit)`. *Rationale:* this is the smallest controller that
  makes the trains *interact* (the point of the increment); dwell/timetable is an
  additive `Path` annotation (`{ edgeId, dwellAt?, departAfter? }`) that feeds the
  same `aiInputs` target without restructuring — don't build the on-ramp to
  nowhere.
- **D5 — Multi-train tick tie-break.** **Derive occupancy from all frame-N
  positions first, then step all trains on the shared clamped `dt`; block
  contention resolves by lower `path`-index train wins, loser sees the block
  occupied and holds.** *Rationale:* a pure function of train order ⇒
  order-independent result (OG8); mirrors the existing advance-then-signal frame
  shape (`main.ts:124-129`); the tie-break is deterministic and total.
- **D6 — Node geometry.** **Pure frame hand-off with divergence baked into the
  child edge's own curvature profile** (not explicit turnout geometry). A
  diverging branch is a child `Edge` whose leading curvature segment bends it
  away; the node is a rigid frame transfer. *Rationale:* every node stays a rigid
  transform (testable by OG1), and the *entire* geometry kernel is reused with
  zero new math; explicit turnout geometry would duplicate curvature integration
  the kernel already does. Visual point-blade rendering, if ever wanted, is a
  render-only flourish that reads the same frames.
- **D7 — AI signalling fidelity.** **Reduced read-aspect-and-obey controller**,
  not the full AWS/penalty machine. The AI reads the next aspect (occupancy-
  broadened `aspectAt`) and brakes on it; it never accrues DSD/AWS/TPWS penalties.
  *Rationale:* the penalty machine models a *human* driver's vigilance lapses —
  meaningless for a deterministic service and pure overhead. The latch release
  contract (`controls.ts:241-291`) is therefore left untouched; occupancy holds
  are *stateless* re-derivations that "re-add themselves" simply by re-running the
  predicate each tick, satisfying the contract's spirit without entering the
  machine.
- **D8 — `TrainPosition.d` vs two edges.** **Parallel tracks are two distinct
  edges** (e.g. `E_main` and `E_loop`), *not* a `d`-offset on one edge. `d` stays
  reserved for lateral placement of render furniture (its existing
  `placeOnCentreline` role) and the running-rail centreline (`d=0`). *Rationale:*
  signalling, occupancy, and routing all key off **edge identity**; a loop must be
  a *separately occupiable block*, which a `d`-offset on a shared edge cannot
  express (it would share the edge's occupancy token). Two edges make "the player
  is on the main, the AI is in the loop" a first-class, testable fact (OG4) and
  keep `d` doing one job.
