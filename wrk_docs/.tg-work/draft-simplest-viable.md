# HLD — Track Graph & Reactive AI (simplest-viable)

Status: DRAFT · 2026.06.20 · supersedes nothing (additive over the Phase-1/2 core)

> **Thesis.** A `TrackGraph` is the existing single-route geometry with the
> integration origin un-hardwired: one new field `EdgeFrame{psi0,x0,z0,h0}` turns
> today's `route` into an `Edge`, and the *already-tested* "next curvature segment
> starts from the running ψ₀ and accumulated (x,z)" compounding (oracle O5b) is
> lifted one level to "next **edge** starts from its parent's exit frame". Trains
> carry `{edgeId,s,d}` instead of a scalar chainage; a thin pure `stepOnGraph`
> wraps the **unchanged** `step()` to carry the residual across an edge join.
> Occupancy is a *derived set* fed into the *existing* `aspectAt` cascade — a
> richer source for the same R→Y→YY→G machine. AI is a pure `aiInputs(...)`
> producing the same `SimInputs` the player's `resolveInputs` produces. No new
> primitives beyond these seven, no interlocking UI, no pathfinding.

---

## 1. Scope & non-goals

### 1.1 In scope (the first acceptance-tested increment)

A **testbed graph** with a through line, a **passing loop**, and a **junction to a
branch**, carrying **two deterministic trains**:

- the **PLAYER**, driving a booked `Path` (an ordered list of edges) the scenario
  fixes — the player may be **looped** (routed via the passing-loop edge) to be
  overtaken, or routed **onto the branch**; there is **no manual point-setting and
  no interlocking UI**;
- one **AI service**, driven by a pure target-speed tracker, that the player **can
  delay by occupying the block ahead of it** (sit in the loop/junction throat the
  AI needs → its protecting signal goes RED → it brakes to a stand and waits).

The increment delivers: the new pure types (`Edge`/`EdgeFrame`, `TrackGraph`/
`Node`, `TrainPosition`, `Path`), the derived `occupancy` predicate folded into
`aspectAt`, the pure `aiInputs(...)`, the pure `stepOnGraph(...)`, an
order-independent multi-train tick wrapper, and AI trains rendered as world
meshes via the existing `placeOnCentreline` primitive.

### 1.2 Non-goals (deferred — explicitly NOT in this increment)

- **No interlocking UI, no signaller, no runtime pathfinding.** Routes are DATA.
  Points are baked into the scenario's `Path`s.
- **No timetable / platform dwell / station-stop logic for AI.** The AI tracks a
  speed target and obeys signals; it does **not** stop at platforms to serve them
  (D-DEC-4). A looped AI just holds at its loop-exit red until the block clears.
- **No `d` as a routing degree of freedom.** `TrainPosition.d` exists (the
  `placeOnCentreline` third argument) but in this increment it is a **constant
  render offset only** (e.g. ±0 for the single track of an edge). Parallel running
  is two distinct edges, never two `d` lanes on one edge (D-DEC-8).
- **No turnout geometry, no moving-blade meshes, no flange/check rails.** A node is
  a pure frame hand-off; divergence is baked into the *branch child edge's
  curvature* (D-DEC-6).
- **No new safety primitive for AI.** AI trains read the aspect and obey a braking
  curve; they do **not** run the AWS/TPWS/DSD machine (D-DEC-7). The player keeps
  the full Phase-2 machine unchanged.
- **No multi-edge occupancy footprint, no train-length sweep across joins.**
  Occupancy granularity is **whole-edge** keyed off a train's *current* `edgeId`
  plus a one-edge look-ahead reservation (D-DEC-3); a train's body is a point at
  `s` for occupancy purposes in this increment.
- **No change to physics `step()`, `acceleration`, the AWS/TPWS/DSD machine, the
  latch-release contract, or any existing oracle.** Those are the asset; they are
  reused verbatim.

---

## 2. The design

### 2.0 Why this is additive, not a rewrite (the keystone)

Today the geometry layer integrates from a hard-wired origin: `centerline.ts:92`
seeds `psi = 0` and `(x,z) = (0,0)`, and `heightAt` measures from the `s=0` datum.
Everything downstream — `planarPoseAt`, `headingAt`, `centerlineAt`, `cantAt`,
`placeOnCentreline` — is integral geometry *relative to that seed*.

The **only** change to make a route into a graph **Edge** is to replace that
hard-wired seed with a per-edge **EdgeFrame**. The arc-accumulation arithmetic in
`planarPoseAt`'s `step()` closure is **byte-identical**; we feed it a non-zero
`psi0` and add a constant rotated offset `(x0,z0)` and height datum `h0` at the
end. Oracle **O5b** (`centerline.test.ts:188`) *already proves* that "arc 2,
integrated from ψ₀=θ₁ and the running (x,z), equals a hand-rotation of arc 2 by
ψ₀ added to arc 1's endpoint." That is **exactly** the edge-join math, one level
up: the parent edge's exit pose **is** the child edge's `EdgeFrame`. The graph
join reuses a proof we already have.

> **Identity special case.** `EdgeFrame = {psi0:0, x0:0, z0:0, h0:0}` reproduces
> today's single route byte-for-byte. The existing route is the graph with one
> edge and the identity frame — so every existing centreline/route/signalling
> oracle continues to pass unchanged against it.

### 2.1 `EdgeFrame` and `Edge` (new pure types, `src/sim/graph.ts`)

```ts
/** The integration origin for an edge: where its s=0 sits in world space and
 *  which way it points. Identity = {psi0:0,x0:0,z0:0,h0:0} reproduces today. */
export interface EdgeFrame {
  psi0: number; // entry heading ψ₀ (rad); seeds planarPose's `psi`
  x0: number;   // entry world X (m)
  z0: number;   // entry world Z (m)
  h0: number;   // entry height datum (m); seeds heightAt's 0
}

export const IDENTITY_FRAME: EdgeFrame = { psi0: 0, x0: 0, z0: 0, h0: 0 };

/** An Edge IS a Route (same 1-D profiles, same signals, same optional viaducts/
 *  tunnels/terrainSeed) plus the frame it integrates from and a stable id.
 *  `Route` is reused verbatim — an Edge is a Route the geometry reads through a
 *  frame. */
export interface Edge {
  id: string;
  route: Route;       // length, grades, speedLimits, curvatures, signals, …
  frame: EdgeFrame;   // integration origin (identity for the legacy single route)
}
```

The geometry functions gain a **frame-aware overload that wraps the existing
ones** — the existing functions are NOT edited; we add thin transformers in
`graph.ts` that pre-seed and post-transform:

```ts
// graph.ts — pure; imports centerline.ts + route.ts only (never render).
export function planarPoseOnEdge(edge: Edge, s: number)
  : { x: number; z: number; heading: number } {
  const local = planarPoseAt(edge.route, s);          // UNCHANGED core, ψ₀=0 origin
  const { psi0, x0, z0 } = edge.frame;
  const c = Math.cos(psi0), sn = Math.sin(psi0);
  return {
    x: x0 + c * local.x + sn * local.z,               // rotate local (x,z) by ψ₀…
    z: z0 - sn * local.x + c * local.z,                // …then translate to (x0,z0)
    heading: psi0 + local.heading,                     // …and add ψ₀ to the heading
  };
}

export function heightOnEdge(edge: Edge, s: number): number {
  return edge.frame.h0 + heightAt(edge.route, s);      // datum shift only
}

export function placeOnEdge(edge: Edge, s: number, d: number)
  : { x: number; y: number; z: number; heading: number } {
  const pose = planarPoseOnEdge(edge, s);              // frame-aware spine pose
  const rx = Math.cos(pose.heading), rz = -Math.sin(pose.heading); // same right-normal
  return { x: pose.x + d * rx, y: heightOnEdge(edge, s), z: pose.z + d * rz,
           heading: pose.heading };
}
```

**Why a wrapper, not an edit to `centerline.ts` (D-DEC chosen).** The rotation +
translation is a *rigid post-transform* of the local pose — algebraically identical
to seeding the integrator. Keeping `centerline.ts` untouched means **every existing
centreline oracle stays green by construction**, and the new transform is proved by
a single composition oracle (P1, §4) plus the identity oracle (P0). The exact form
above is the same `(cos,−sin)/(sin,cos)` planar rotation O5b already exercises —
verifying `planarPoseOnEdge(edge_with_frame, s) == hand-rotation of the local pose`
is the O5b proof generalised from "second arc" to "second edge". `cantAt`,
`headingAt`'s heading value, and the tangent/up vectors are **frame-invariant in
magnitude** (cant depends on κ and v only; heading just adds ψ₀), so they reuse the
core unchanged and only the *heading* is offset by ψ₀ at the `centerlineAt`
adapter.

### 2.2 `Node` and `TrackGraph` (new pure types, `src/sim/graph.ts`)

```ts
/** A node hands the EXIT frame of one edge to the ENTRY frame of the next. It
 *  carries no geometry of its own — it is the *equality* of two frames. */
export interface TrackGraph {
  edges: Record<string, Edge>;     // by id
  // Adjacency is implicit in the Paths (scenario data); see §2.4. No turnouts.
}

/** The exit frame of an edge = its pose at s = length, as an EdgeFrame. This is
 *  the value a child edge's `frame` MUST equal (to 1e-6) for continuity. */
export function exitFrame(edge: Edge): EdgeFrame {
  const pose = planarPoseOnEdge(edge, edge.route.length);
  return { psi0: pose.heading, x0: pose.x, z0: pose.z,
           h0: heightOnEdge(edge, edge.route.length) };
}
```

**Continuity is an authoring invariant, machine-checked (oracle P2, §4).** For
every edge that a `Path` joins parent→child, `entryFrame(child) == exitFrame(parent)`
within `1e-6` in position **and** heading (`h0` within `1e-6` too). This is exactly
the continuity the brief names and the same tolerance O5b/O4 already use. The
scenario author either (a) computes a child's `frame` *from* its parent's
`exitFrame` (the normal case — the graph is built by walking edges and threading
exit→entry), or (b) hand-authors a frame and the oracle catches any mismatch. A
junction simply gives the *branch* child a different `frame` derived from the same
parent exit but with the divergence baked into the **branch edge's own opening
curvature** (D-DEC-6) — the node itself stores nothing.

> There is **no separate node object with coordinates**. "Node" is a *concept* —
> the equality `exit(parent) == entry(child)`. The simplest possible model: a graph
> is a bag of edges plus the Paths that thread them. This is the whole graph model;
> it fits in one head.

### 2.3 `TrainPosition` and `Path` (new pure types)

```ts
/** Replaces the scalar SimState.chainage with a position ON THE GRAPH. */
export interface TrainPosition {
  edgeId: string; // which edge the train is on
  s: number;      // chainage along THAT edge, m (0..edge.length)
  d: number;      // lateral render offset, m (constant per train in this increment)
}

/** A booked route = an ordered list of edge ids. Scenario data; no pathfinding. */
export type Path = string[]; // edge ids, parent→child, continuity-checked (P2)
```

`SimState` is **unchanged** (`simulation.ts:22`) — `step()` still operates on a
scalar `chainage` *within the current edge's route*. `TrainPosition` lives in the
new per-train record (§2.6) **alongside** `SimState`; `state.chainage` is the `s`
of the current edge, and the graph wrapper reconciles `edgeId`/residual at the
join. `SimState.chainage` is never globalised — every consumer (physics, signalling,
AWS) keeps reading the *edge-local* `s` it already reads, so none of them change.

### 2.4 `stepOnGraph` — the join wrapper (new pure layer over UNCHANGED `step()`)

This is the **most error-prone seam**, so it is the thinnest possible pure layer
and gets the most oracles.

```ts
// graph.ts — pure. Wraps step() once; carries the residual onto the next booked
// edge when s crosses edge.length. step() itself is UNCHANGED (simulation.ts:45).
export interface GraphStepResult { state: SimState; pos: TrainPosition; }

export function stepOnGraph(
  graph: TrackGraph,
  path: Path,
  spec: TrainSpec,
  state: SimState,           // .chainage is the CURRENT edge's s
  pos: TrainPosition,
  inputs: SimInputs,
  dt: number,
): GraphStepResult {
  const edge = graph.edges[pos.edgeId];
  const next = step(spec, edge.route, state, inputs, dt);   // UNCHANGED core
  // Did we run off the END of this edge with a successor booked?
  const nextEdgeId = successor(path, pos.edgeId);           // next id in the Path
  if (next.chainage >= edge.route.length && next.speed > 0 && nextEdgeId) {
    const residual = next.chainage - edge.route.length;     // metres past the join
    // Hand off: the residual becomes s on the next edge; speed/brakeActual/time
    // carry; chainage resets to the residual. Direction/sign: see below.
    const handed: SimState = { ...next, chainage: residual };
    return { state: handed, pos: { edgeId: nextEdgeId, s: residual, d: pos.d } };
  }
  // No successor: the end-clamp speed=0 at route.length (simulation.ts:88-91)
  // SURVIVES — this edge is a true buffer-stop edge (last in the Path).
  return { state: next, pos: { edgeId: pos.edgeId, s: next.chainage, d: pos.d } };
}
```

**Junction orientation/sign reconciliation (D-DEC-1, the named hazard).** We make
it a **non-problem by construction**: every edge in every `Path` is authored
**forward** — `s` increases 0→length in the train's booked direction of travel, and
`EdgeFrame` already encodes the world heading at the join (`exitFrame` gives the
child its `psi0`). So at a join the residual is **always positive `s`** on the next
edge, `dir` is **always +1**, and there is **no sign flip to reconcile**. A train
"looped to be passed" runs forward through the loop edge (which curves out and back
in via its own curvature) and forward through the loop-exit edge; reverse running
(`dir = -1`) does **not** cross edge joins in this increment (a reversing player just
runs `s` back down the *current* edge and clamps at `s=0`, exactly as today). This
collapses the entire orientation-reconciliation surface to: *carry the residual,
keep `dir`*. The oracle (G-JOIN, §4) proves the join is dt-slice-stable and that the
world pose is continuous across it (`placeOnEdge` of the last-on-parent point ==
`placeOnEdge` of the first-on-child point, to 1e-6 — which holds *because* P2
guarantees `entry(child)==exit(parent)`).

### 2.5 Occupancy — a derived set folded into the EXISTING cascade

Occupancy is **never stored**. It is a pure predicate over **all** trains'
`TrainPosition`s, computed once per tick and folded into `aspectAt` as a **richer
source set**, exactly as the brief mandates — not a new signal primitive.

```ts
// graph.ts — pure. Block granularity = WHOLE EDGE (D-DEC-3).
/** The set of edge ids currently occupied: each train occupies its current edge
 *  AND reserves the NEXT booked edge once within RESERVE_M of the join (so a
 *  follower is held while the leader is still clearing the turnout throat). */
export function occupiedEdges(
  trains: { pos: TrainPosition; path: Path; speed: number; edgeLen: number }[],
): ReadonlySet<string> {
  const occ = new Set<string>();
  for (const t of trains) {
    occ.add(t.pos.edgeId);                                  // current edge
    const nextId = successor(t.path, t.pos.edgeId);
    if (nextId && t.edgeLen - t.pos.s <= RESERVE_M) occ.add(nextId); // look-ahead
  }
  return occ;
}
```

**How it enters the aspect cascade (the keystone reuse).** `aspectAt`
(`route.ts:243`) is RED iff `!served.has(sig.protects)`. We *grow the source set*
the cascade reads from "served stations" to "served stations **and** blocks
clear ahead". Concretely, a signal at the entrance to an edge `e` is RED if `e`
(or the throat edge it protects) is in `occupiedEdges` **by another train**. We
express this without touching `aspectAt`'s recursion by computing, per signal, an
**effective served-set** for the querying train:

```ts
// For a given train, the set fed to aspectAt is the union of:
//   served stations  ∪  {station of any starter whose protected block is CLEAR}.
// A starter's block is CLEAR (so it may show non-RED) iff the edge it guards is
// NOT occupied by ANOTHER train. Occupied-by-another ⇒ remove that station from
// the effective set ⇒ aspectAt sees it as unserved ⇒ RED. The R→Y→YY→G cascade
// and its strictly-increasing-index termination proof are UNCHANGED.
export function effectiveServed(
  baseServed: ReadonlySet<string>,
  guardedStationOfEdge: (edgeId: string) => string | null,
  occByOthers: ReadonlySet<string>,
): ReadonlySet<string> {
  const eff = new Set(baseServed);
  for (const edgeId of occByOthers) {
    const station = guardedStationOfEdge(edgeId);
    if (station) eff.delete(station);     // occupied block ⇒ its starter held RED
  }
  return eff;
}
```

This is the brief's "player delays AI by occupying a block ahead" expressed as a
**richer set source, not a new primitive**: when the player sits in the loop edge
the AI must enter, that edge is `occByOthers` for the AI, so the AI's effective
served-set drops the loop's station, so the protecting starter is RED, so the AI
brakes and holds. When the player clears the edge, the set no longer demands the
hold and the starter returns to YELLOW/GREEN — and the AI proceeds. No new signal
kind; the station-starter cascade is overlaid (D-DEC-3). The latch-release contract
(`controls.ts:241-251`) is untouched because **occupancy is not a latched penalty**
— it is a *signal aspect* the AI's controller reads each tick; a persisting hold
simply keeps failing the "block clear" predicate every tick, which is the
contract's "source still demands it" shape, with no release machine to touch.

### 2.6 `aiInputs` — the AI controller (new pure module, `src/sim/ai.ts`)

```ts
// ai.ts — pure; imports route.ts + physics.ts + simulation.ts (NO render, NO
// centerline — it is a 1-D longitudinal controller, same layer as controls.ts).
/** Produces the SAME SimInputs resolveInputs produces, so it plugs in at the
 *  EXACT physics seam. A target-speed tracker: the target is the MIN of
 *    (1) the PSR ahead (speedLimitAt on this edge),
 *    (2) the red/yellow braking-curve ceiling v = sqrt(2·a·distanceToStop), and
 *    (3) a line speed cap.
 *  Below target ⇒ notch up; above ⇒ brake; at a red ahead ⇒ brake to a stand. */
export function aiInputs(
  edge: Edge,
  state: SimState,
  aspectAhead: Aspect,             // from effectiveServed → aspectAt
  distToSignalAhead: number,       // m to the next signal post (edge-local)
  spec: TrainSpec,
  mu: number,
): SimInputs {
  const psr = speedLimitAt(edge.route, state.chainage);
  const curveCeil = brakingCurveCeiling(aspectAhead, distToSignalAhead, spec); // v² = 2·a·d
  const target = Math.min(psr, curveCeil, AI_LINE_CAP);
  const v = Math.abs(state.speed);
  const notch = v < target - AI_HYST ? 1 : 0;             // simple bang-bang to target
  const brake = v > target + AI_HYST ? 1 : 0;             //   (hysteresis band)
  return { notch, brake, dir: 1, mu, emergency: false };  // dir always +1 (§2.4)
}
```

**Fidelity (D-DEC-4): PSR + braking-curve tracker ONLY.** No platform dwell, no
timetable, no station serving. A red aspect ahead drives `curveCeil → 0` as the
train nears the post, so it brakes smoothly to a stand at the signal and holds —
which is all the increment needs (the player delays it; it waits; when the block
clears the aspect lifts and `curveCeil` releases). The `brakingCurveCeiling` uses
the **same** decel target the player's braking obeys (reuse `acceleration`/the
service-brake decel from `physics.ts`), so the AI and player share one physics
truth. `aiInputs` is bang-bang with a hysteresis band — the simplest tracker that
holds a target and respects a red; a PID is over-engineering for this scope.

> The AI obeys signals by **reading the aspect** (D-DEC-7); it does **not** run AWS/
> TPWS/DSD. There is no driver to warn, no vigilance to keep. Its safety is "see
> red → braking curve → stop", entirely inside `aiInputs`. This keeps the whole
> Phase-2 penalty machine player-only and untouched.

### 2.7 The multi-train tick (order-independent) — `src/sim/multitrain.ts`

```ts
// multitrain.ts — pure orchestration over the per-train records. NO render.
export interface TrainRecord {
  id: string;
  path: Path;
  pos: TrainPosition;
  state: SimState;
  kind: "player" | "ai";
  // player also carries controls/safety/aws; ai carries none (D-DEC-7).
}

/** One tick: derive occupancy from ALL trains' frame-N positions, THEN step every
 *  train on the shared clamped dt. Order-independent: occupancy is sampled BEFORE
 *  any train moves (advance-first-then-signal preserved, main.ts:124-129). */
export function tickAll(
  graph: TrackGraph, records: TrainRecord[], dt: number, mu: number,
  playerInputs: SimInputs,               // from resolveInputs in the impure shell
): TrainRecord[] {
  // 1. Occupancy from frame-N positions (each train's own edge excluded for itself).
  const occ = occupiedEdges(records.map(toOccInput));
  // 2. Step each train independently on the SAME dt.
  return records.map((r) => {
    const occByOthers = without(occ, r.pos.edgeId);            // exclude self
    const inputs = r.kind === "player"
      ? playerInputs                                           // player drives
      : aiInputs(graph.edges[r.pos.edgeId], r.state,
                 aspectAheadFor(graph, r, occByOthers), … , mu);
    const { state, pos } = stepOnGraph(graph, r.path, spec(r), r.state, r.pos, inputs, dt);
    return { ...r, state, pos };
  });
}
```

**Tie-break for block contention (D-DEC-5).** Occupancy is sampled **once, from
frame-N positions, before anyone moves**, so the tick is order-independent: two
trains contending for an edge both see it as the *other's* occupancy → both are held
RED → **mutual yield** (safe deadlock-avoidance: neither enters a contested block in
the same frame). The scenario authoring guarantees this never wedges permanently
because only one train is ever *booked* through a shared edge at a time in this
testbed (the loop exists precisely to separate them). No priority field, no
sequence number, no first-come arbitration — the *occupancy snapshot itself* is the
tie-break, and it is deterministic because it depends only on positions, not order.

### 2.8 Render — AI trains as world meshes (`src/render/scene.ts`, impure)

AI trains are **new meshes** placed with the **same primitive lineside furniture
uses**: `placeOnEdge(edge, s, d)` → `(x,y,z,heading)`. The render layer maps each AI
`TrainRecord` to a box/EMU mesh and sets its transform from `placeOnEdge`; the
player's camera stays single-train (driven by the player record's edge+s). This is
the only render change and it adds **no new render concept** — it is `placeOnCentreline`
generalised to `placeOnEdge`, the same generalisation the geometry layer got. Render
imports `graph.ts` (sim→render direction is allowed; render→sim is the forbidden
one, and O17 only forbids the *physics path* importing the *spatial core*, which is
unaffected).

### 2.9 Wiring summary (one paragraph, one head)

The impure shell (`main.ts`) builds the `TrackGraph` and the two `Path`s from
scenario data, holds an array of `TrainRecord`s, and each frame: reads the wall
clock once for `dt` (the only clock), runs the player's existing keyboard→`reduceControls`
→`resolveInputs` pipeline to get `playerInputs`, calls the **pure** `tickAll(graph,
records, dt, mu, playerInputs)`, runs the player's existing `tickAws`/`tickSafety`
on the player record (edge-local `s`), then renders every record via `placeOnEdge`
and updates the HUD from the player record. **All logic is pure and tested; the shell
has none.**

---

## 3. File-level impact map

Respecting G3 (no clock/random in `src/sim/*` or `src/render/quality.ts`), O17
(physics path must not import the spatial core; sim must not import render), and the
pure/impure split (`main.ts` is the untested shell with no logic).

### NEW — pure sim modules (`src/sim/`), all dt-/position-driven, G3-clean

| File | Why |
|---|---|
| `src/sim/graph.ts` | `EdgeFrame`, `Edge`, `TrackGraph`, `TrainPosition`, `Path`, `IDENTITY_FRAME`; the frame-aware geometry wrappers (`planarPoseOnEdge`/`heightOnEdge`/`placeOnEdge`/`exitFrame`); `stepOnGraph`; `occupiedEdges`/`effectiveServed`. Imports `centerline.ts`, `route.ts`, `simulation.ts`, `physics.ts` only. **No render import.** |
| `src/sim/ai.ts` | `aiInputs` + `brakingCurveCeiling`. Imports `route.ts`, `physics.ts`, `simulation.ts`, `graph.ts`. Same layer as `controls.ts` (1-D longitudinal). **No render, no centerline.** |
| `src/sim/multitrain.ts` | `TrainRecord`, `tickAll`. Pure orchestration. Imports `graph.ts`, `ai.ts`, `simulation.ts`. **No render.** |
| `src/sim/testbed.ts` | The first scenario as DATA: the testbed `TrackGraph` (through line + passing loop + branch junction edges, frames threaded by `exitFrame`) and the player/AI `Path`s. Pure constants; imports `route.ts`, `graph.ts`. |

### CHG — existing sim (additive only; no behaviour change to the asset)

| File | Change | Risk |
|---|---|---|
| `src/sim/route.ts` | **None to logic.** `Route` is reused verbatim as `Edge.route`. (Possible: re-export nothing new.) | none |
| `src/sim/simulation.ts` | **None.** `step()` untouched; `stepOnGraph` wraps it externally. | none |
| `src/sim/controls.ts`, `aws.ts`, `physics.ts`, `centerline.ts` | **None.** Reused verbatim. | none |

> The asset is genuinely untouched. Everything new is a *wrapper* or *orchestrator*
> in a new file. This is the strongest possible "extend, not rewrite" guarantee.

### CHG — render + shell (impure)

| File | Change |
|---|---|
| `src/render/scene.ts` | Add AI-train meshes; position each via `placeOnEdge`. May import `graph.ts` (sim→render is allowed). |
| `src/main.ts` | Build graph + paths from `testbed.ts`; hold `TrainRecord[]`; call `tickAll`; render all records. **No new logic** — pure functions do the work. |

### NEW — tests (`test/`)

| File | Covers |
|---|---|
| `test/graph.test.ts` | Frame identity (P0), frame composition vs O5b hand-rotation (P1), continuity oracle (P2), `stepOnGraph` join (G-JOIN, J1–J3), occupancy/`effectiveServed` (OCC1–OCC3). |
| `test/ai.test.ts` | `aiInputs` tracking + braking-curve-to-red-stop (AI1–AI3). |
| `test/multitrain.test.ts` | Order-independence (MT1), mutual-yield contention (MT2), end-to-end "player delays AI" scenario (S1). |

The existing `test/world.test.ts` O17 guard is **extended** to also assert
`graph.ts`/`ai.ts`/`multitrain.ts` do not import `render/`; the G3 grep in
`signalling.test.ts` already globs `src/sim/*.ts`, so the new modules are
automatically covered (a new `Date`/`Math.random` would fail the build) — **no edit
needed there.**

---

## 4. Acceptance criteria — numbered pure test oracles (definition of done)

All oracles are pure (no DOM, no Three, no wall clock), driven by explicit `dt` and
positions. "≈" means `toBeCloseTo` at the stated decimals.

**Frame & geometry**

- **P0 (identity).** For the legacy route as an edge with `IDENTITY_FRAME`,
  `planarPoseOnEdge`, `heightOnEdge`, `placeOnEdge` ≈ `planarPoseAt`/`heightAt`/
  `placeOnCentreline` at 12 decimals for `s ∈ {0,1000,6000,…}`, `d ∈ {−3,0,7}`.
  *(The legacy route is the one-edge identity graph.)*
- **P1 (frame composition = O5b lifted).** Build edge B whose `frame` =
  `exitFrame(A)` for two arcs A,B. Then `planarPoseOnEdge(B, sB)` ≈ the
  hand-rotation of B's local pose by A's exit heading added to A's exit point, at 6
  decimals — i.e. the graph join reproduces O5b's two-arc result with B as a
  separate edge rather than a second curvature segment.
- **P2 (continuity invariant).** For every parent→child pair in every testbed
  `Path`, `entryFrame(child) == exitFrame(parent)` in `(x,z)` within `1e-6`, in
  `heading (psi0)` within `1e-6`, and in `h0` within `1e-6`. *(Graph-level
  generalisation of O4/O5b continuity.)*
- **P3 (per-edge invariants).** For every edge: `minCurveRadius(edge.route) ≥ 250`;
  if terrain-rendered, `ribbonHalfWidth ≤ 0.5·minCurveRadius(edge.route)`; every
  viaduct/tunnel band lies wholly on a κ=0 segment; every curve's cant stays off the
  ceiling (`0.08·|κ|·v² ≤ 0.105`). *(Per-route invariants made PER-EDGE; a
  graph-level loop runs the existing checks over `Object.values(graph.edges)`.)*

**Join (`stepOnGraph`)**

- **J1 (residual carry).** A train with `speed > 0` whose `step()` would put
  `chainage` at `edge.length + r` lands at `edgeId = successor`, `s ≈ r`, with
  `speed`/`brakeActual`/`time` carried unchanged.
- **J2 (world continuity across the join).** `placeOnEdge(parent, parent.length, d)`
  ≈ `placeOnEdge(child, 0, d)` at 1e-6 for the booked parent→child pair *(follows
  from P2)*.
- **J3 (buffer-stop survival).** On the **last** edge of a Path (no successor), the
  end-clamp `speed = 0 at route.length` (`simulation.ts:88-91`) still fires — the
  train stops at the buffers and does not hand off.
- **G-JOIN (dt-slice independence across a join).** For a STEADY span (`dt ≤ 0.05`,
  no aspect change) that crosses one edge join, one coarse step and N fine sub-steps
  reach the same final `(edgeId, s, speed)` within 1e-6. *(Generalises the existing
  G-class dt-slice oracles to the join.)*

**Occupancy & AI**

- **OCC1.** `occupiedEdges` returns each train's current edge; and its next booked
  edge once `edgeLen − s ≤ RESERVE_M`.
- **OCC2 (richer-source RED).** With the player occupying the loop edge `L`,
  `effectiveServed` for the AI drops `L`'s station, so `aspectAt` for the AI's
  loop-entry starter is **RED**; the R→Y→YY→G cascade behind it is unchanged
  (re-runs A1-style assertions with the occupancy-derived set).
- **OCC3 (release).** When the player leaves `L` (no longer in `occByOthers`),
  `effectiveServed` restores `L`'s station and the starter returns to YELLOW/GREEN.
  *(No latch touched — pure re-derivation each tick.)*
- **AI1 (tracks PSR).** On a clear edge with a posted limit `v`, `aiInputs` drives
  the train to `≈ v` (within the hysteresis band) and holds.
- **AI2 (brakes to a red).** With `aspectAhead = RED` at distance `d`, the AI's
  target ≤ braking-curve ceiling, and integrating `stepOnGraph` forward brings the
  train to a **stand at or before the signal post** (final `s ≤ postS`, `speed ≈ 0`).
- **AI3 (proceeds on clear).** From the held stand, flip `aspectAhead` to GREEN; the
  AI accelerates away (`speed` strictly increases over the next ticks).

**Multi-train & the headline scenario**

- **MT1 (order independence).** `tickAll` over `records` in any permutation yields
  identical post-tick `(edgeId,s,speed)` for every train.
- **MT2 (mutual yield).** Two trains booked into a shared edge in the same frame:
  both see it occupied-by-other → both held RED → neither enters it that frame
  (deterministic, no priority field).
- **S1 (DONE — "player delays one AI at red").** The acceptance scenario end-to-end:
  on the testbed graph, run the player into the passing-loop edge and hold there; an
  AI service booked through the loop approaches, its loop-entry starter goes RED via
  occupancy, and it **brakes to a stand and waits** (oracle: AI `speed` reaches 0 and
  stays 0 while the player occupies `L`). Then move the player out; the AI's starter
  clears and the AI **resumes and completes its Path** to its buffer-stop edge
  (oracle: AI `speed > 0` resumes within K ticks and final `pos.edgeId` is the last
  edge of its Path with `speed ≈ 0` at the buffers). Fully deterministic, dt-driven.

### The concrete first testbed graph (`src/sim/testbed.ts`)

A minimal graph, frames threaded by `exitFrame`:

- **E_main_in** — straight approach edge, ~800 m, `IDENTITY_FRAME`. Ends at the
  junction throat. Carries the loop-entry starter (a station-starter overlay
  protecting the loop block).
- **E_loop** — the passing-loop edge, ~400 m, gentle out-and-back curvature
  (`|κ| ≤ 1/300`, so `R ≥ 300 ≥ 250`), `frame = exitFrame(E_main_in)` plus the small
  lateral via its own opening curvature (D-DEC-6). Has a platform-less "passing"
  station for the starter overlay.
- **E_branch** — the diverging branch edge, ~600 m, opening curve then straight,
  `frame = exitFrame(E_main_in)` with a different `psi0`/curvature (the divergent
  road). Ends at **E_branch_buffer** (buffer-stop, last in the branch Path).
- **E_main_out** — the through continuation past the loop, ~800 m, `frame =
  exitFrame(E_loop)`; ends at **E_main_buffer** (buffer-stop).

**Paths (scenario data):**

- **Player** (looped to be passed): `[E_main_in, E_loop, E_main_out, E_main_buffer]`.
- **AI service** (through, delayed by the player in the loop): `[E_main_in,
  E_loop, E_main_out, E_main_buffer]` — staggered start behind the player so the
  occupancy interaction is exercised. *(For the branch demonstration, an alternate
  AI Path `[E_main_in, E_branch, E_branch_buffer] ` shows divergence; the headline S1
  uses the loop conflict.)*

This is the smallest graph exhibiting all three required features (multiple tracks,
a junction, an alternate route) and exactly one AI the player can hold at red.

---

## 5. Residual risks

1. **Join sign correctness depends on the "all-forward authoring" rule.** If a
   future scenario books an edge *against* its `s` direction, the residual-carry
   assumption (§2.4) breaks. **Mitigation:** P2 + G-JOIN catch any frame
   discontinuity; an explicit authoring assertion (`Path` edges are forward) is the
   guard. Reverse-through-a-join is deferred (non-goal) precisely to keep this true.
2. **Whole-edge occupancy is coarse.** A long edge occupied by a train far from the
   join still holds a follower out. **Mitigation:** acceptable for the testbed
   (edges are short and sized to the conflict); sub-interval blocks are a clean later
   extension (split an edge into block-sized child edges — *more data, no new
   concept*). Flagged, not solved now.
2.b **Mutual-yield could wedge** if a scenario genuinely books two trains through one
    edge with no loop to separate them. **Mitigation:** the testbed's loop exists to
    prevent this; MT2 documents the behaviour; scenario authoring (not runtime
    arbitration) owns conflict-freedom. A priority field is the escape hatch if ever
    needed — deliberately not built now.
3. **AI bang-bang may chatter** near the target/at the braking-curve knee.
   **Mitigation:** the hysteresis band; if visible, a single-pole filter on the
   target is a contained follow-up. Determinism is unaffected (no clock).
4. **`d` is inert.** Parallel platform faces / four-foot offsets are render-only and
   uniform per train this increment; if a scenario needs true parallel running it is
   two edges (per D-DEC-8), which the model already supports — no rework, just data.
5. **Render perf with N AI meshes** is out of the tested core; the increment ships
   **one** AI train, so this is a non-issue now and bounded later by mesh reuse.

---

## 6. Decision log (resolves all 8 open decisions)

**D-DEC-1 — Junction orientation/sign reconciliation (+ oracle).**
*Resolved: all-forward authoring → carry-residual, keep `dir=+1`; no sign flip.*
Every edge in every `Path` is authored so `s` increases in the booked travel
direction, and `EdgeFrame` already carries the world heading at the join. The
residual past `edge.length` becomes positive `s` on the next edge; nothing is
mirrored. Reverse running does not cross joins (deferred). This collapses the
hazard to a one-line hand-off. **Oracle:** J1 (residual carry), J2 (world
continuity, ≤1e-6), G-JOIN (dt-slice stable). *Rationale: the simplest model that
is provably continuous; reverse-through-joins is real but unneeded for the
requirement, so cutting it removes the entire sign-reconciliation surface.*

**D-DEC-2 — `stepOnGraph` as a NEW pure layer vs thickening `step()`.**
*Resolved: NEW thin pure wrapper; `step()` stays byte-identical.* Thickening
`step()` would risk every existing physics/AWS/reach oracle and globalise
`chainage`. The wrapper carries the residual onto the next edge and leaves the
end-clamp to fire only on a true buffer-stop edge. *Rationale: protect the asset;
the seam gets its own oracles (J/G-JOIN) without endangering the proven core.*

**D-DEC-3 — Block granularity & new signal kind vs overlay.**
*Resolved: WHOLE-EDGE blocks; OVERLAY the existing station-starter cascade — no new
signal kind.* Occupancy removes a station from a *querying train's effective
served-set*, which makes the existing starter RED through the unchanged `aspectAt`
recursion. The R→Y→YY→G cascade and its strictly-increasing-index termination proof
are reused verbatim. *Rationale: the brief's mandate — occupancy is a richer SET
SOURCE, not a new primitive; whole-edge is the coarsest correct granularity and the
smallest amount of new state (none — it is derived).*

**D-DEC-4 — AI fidelity.**
*Resolved: PSR + braking-curve tracker ONLY; no dwell/timetable.* Target = min(PSR,
braking-curve ceiling to a red, line cap); bang-bang with hysteresis. A red ahead
brakes it to a stand at the post and holds. *Rationale: this is exactly enough to be
delayed by the player and to interact via occupancy; dwell/timetable add state and
oracles the requirement does not need. Deferred cleanly (add a dwell timer keyed to
`s` at a platform later).*

**D-DEC-5 — Multi-train tick tie-break for block contention.**
*Resolved: occupancy sampled once from frame-N positions before any train moves →
mutual yield; no priority field.* The snapshot itself is the deterministic
tie-break; order-independence (MT1) follows because stepping reads a *pre-computed*
occupancy set. *Rationale: order-independence is a hard constraint; a priority field
is extra state with no requirement behind it. Scenario authoring (the loop) prevents
permanent wedging.*

**D-DEC-6 — Node geometry: pure frame hand-off vs explicit turnout geometry.**
*Resolved: pure frame hand-off; divergence baked into the branch child edge's
opening curvature.* A node stores nothing; it is the equality
`entry(child)==exit(parent)`. The branch simply has a child edge whose `frame`
shares the parent exit point but whose own curvature opens away. *Rationale: no
turnout mesh, no blade state, no new geometry primitive — the tightest possible
model; the divergence is just an edge that curves, which the existing curvature
machinery and per-edge `minCurveRadius≥250` oracle already cover.*

**D-DEC-7 — AI trains' signalling: full AWS/penalty vs reduced read-aspect.**
*Resolved: reduced — AI reads the aspect and obeys a braking curve; NO AWS/TPWS/DSD.*
The full machine exists to protect a human driver (vigilance, magnets, penalty ack);
an AI has none of that. Its safety is the braking-curve-to-red inside `aiInputs`.
*Rationale: keeps the entire Phase-2 penalty/latch machine player-only and untouched
(zero risk to those oracles), and removes a large pile of state the AI does not
need.*

**D-DEC-8 — `TrainPosition.d`: parallel as a `d`-offset on ONE edge vs two edges.**
*Resolved: parallel running is TWO DISTINCT EDGES; `d` is a constant per-train
render offset only.* Two tracks = two edges with their own frames/signals/occupancy;
`d` never carries routing meaning. *Rationale: occupancy, signalling, and joins all
key off `edgeId`; overloading `d` as a second lane would fork every one of those.
One concept per axis: `edgeId` routes, `s` advances, `d` only nudges the mesh
sideways. The passing loop is therefore a real separate edge — which is exactly what
makes the occupancy interaction (and S1) work.*

---

### Appendix — the seven new pure concepts, in one breath

`EdgeFrame` (un-hardwire the integration origin) → `Edge` (a Route read through a
frame) → `TrackGraph` (a bag of edges joined by `exit==entry`) → `TrainPosition
{edgeId,s,d}` (where a train is) → `Path` (the booked edge list) → derived
`occupancy` (who's where, folded into the unchanged `aspectAt`) → `aiInputs` (a
target-speed tracker emitting `SimInputs`) → `stepOnGraph` (carry the residual
across a join over the unchanged `step()`). Nothing else. The asset — `step()`,
`acceleration`, the AWS/TPWS/DSD machine, the latch-release contract, every
existing oracle — is reused verbatim.
