// The centerline-free 1-D track-graph logic (HLD §3.4–3.7): the join wrapper
// `stepOnGraph`, derived physical occupancy folded into the existing signal
// cascade, the reactive-AI controller, and the order-independent multi-train
// tick. Inside the O17 longitudinal fence: imports the dynamics/physics/route
// layers and `graph.ts`, but NEVER `centerline.ts` or `graph-geom.ts` — the
// longitudinal path never reaches the spatial core. No clock, no randomness.

import { step, type SimState, type SimInputs } from "./simulation";
import type { TrainSpec } from "./physics";
import type { Aspect } from "./route";
import { aspectAt, nextSignalAhead, speedLimitAt } from "./route";
import type { Edge, TrackGraph, Path, TrainPosition } from "./graph";
import { successor } from "./graph";

/** Bang-bang hysteresis half-band around the target, m/s. */
export const AI_HYST = 0.5;
/** Braking safety margin, m: the AI plans to stop this far SHORT of a red post,
 *  covering brake build-up lag + bang-bang discretisation so it halts at or
 *  before the post (AI2), like a real driver braking within the signal overlap. */
export const AI_BRAKE_MARGIN = 50;

// ── the join wrapper (HLD §3.4) ───────────────────────────────────────────────

export interface GraphStepResult {
  state: SimState;
  pos: TrainPosition;
}

/**
 * Advance one train on the graph by `dt`. A non-terminal edge passes
 * `clampAtEnd = false` to `step()` so the train may run past `route.length` with
 * speed retained; the residual is then carried onto the successor edge. A
 * terminal (buffer-stop) edge uses the default `true`, so the end-stop fires (J3).
 * `validateGraph`'s P-LEN invariant guarantees the residual never overshoots a
 * whole child edge, so at most one join happens per tick — no carry loop needed.
 */
export function stepOnGraph(
  graph: TrackGraph,
  path: Path,
  spec: TrainSpec,
  state: SimState,
  pos: TrainPosition,
  inputs: SimInputs,
  dt: number,
): GraphStepResult {
  const edge = graph.edges[pos.edgeId] as Edge;
  const nextEdgeId = successor(path, pos.edgeId);
  const isTerminal = nextEdgeId === null;
  const next = step(spec, edge.route, state, inputs, dt, /* clampAtEnd */ isTerminal);
  if (!isTerminal && next.chainage >= edge.route.length && next.speed > 0) {
    const residual = next.chainage - edge.route.length; // > 0: the clamp was suppressed
    const handed: SimState = { ...next, chainage: residual }; // speed/brakeActual/time carry
    return { state: handed, pos: { edgeId: nextEdgeId as string, s: residual, d: pos.d } };
  }
  // Terminal ⇒ end-stop fired (J3); non-crossing ⇒ stayed on this edge.
  return { state: next, pos: { edgeId: pos.edgeId, s: next.chainage, d: pos.d } };
}

// ── occupancy — derived PHYSICAL clear-block tokens (HLD §3.5) ─────────────────

/** Each train occupies its CURRENT edge only (whole-edge physical blocks). */
export function occupiedEdges(records: { id: string; pos: TrainPosition }[]): ReadonlySet<string> {
  return new Set(records.map((r) => r.pos.edgeId));
}

/**
 * The signal source set for ONE train: its base served stations ∪ the tokens of
 * every BLOCK edge NOT occupied by another train. A block edge id occupied by
 * another train ⇒ its token is ABSENT ⇒ `aspectAt`'s `!source.has(sig.protects)`
 * ⇒ RED. The R→Y→YY→G cascade and its termination proof are reused verbatim;
 * the only change is a richer source set. Block tokens are edge ids; OCC-NS
 * guarantees they never alias a station name.
 */
export function aspectSource(
  baseServed: ReadonlySet<string>,
  blockEdgeIds: readonly string[],
  occByOthers: ReadonlySet<string>,
): ReadonlySet<string> {
  const src = new Set(baseServed);
  for (const e of blockEdgeIds) if (!occByOthers.has(e)) src.add(e); // clear ⇒ token present
  return src;
}

// ── the reactive-AI controller (HLD §3.6) ─────────────────────────────────────

/** Service-brake curve ceiling to a red post `d` metres ahead: v = √(2·a·(d−margin)).
 *  Brakes ONLY for RED (per AI2); unbounded otherwise. The margin makes the planned
 *  stop fall short of the post so brake-lag overshoot still halts at or before it. */
export function brakingCurveCeiling(
  aspectAhead: Aspect,
  distToSignalAhead: number,
  spec: TrainSpec,
): number {
  if (aspectAhead !== "RED") return Infinity;
  const usable = Math.max(0, distToSignalAhead - AI_BRAKE_MARGIN);
  return Math.sqrt(2 * spec.brakeServiceDecel * usable);
}

/**
 * The same `SimInputs` `resolveInputs` produces, at the exact physics seam. Target
 * = min(PSR ahead, braking-curve ceiling to a red on THIS edge, line cap);
 * bang-bang with a hysteresis band. PSR + braking-curve tracker only — no
 * dwell/timetable; reads the aspect but runs no AWS/TPWS/DSD (D-DEC-4/7).
 */
export function aiInputs(
  edge: Edge,
  state: SimState,
  aspectAhead: Aspect,
  distToSignalAhead: number,
  spec: TrainSpec,
  mu: number,
): SimInputs {
  const psr = speedLimitAt(edge.route, state.chainage);
  const curveCeil = brakingCurveCeiling(aspectAhead, distToSignalAhead, spec);
  const target = Math.min(psr, curveCeil, spec.speedMax);
  const v = Math.abs(state.speed);
  // A target at or below the hysteresis band means "come to / hold a stand" (a red
  // braking-curve ceiling at the post): apply the brake so the train holds rather
  // than coasting in the band and creeping on a grade.
  if (target <= AI_HYST) {
    return { notch: 0, brake: 1, dir: 1, mu, emergency: false };
  }
  return {
    notch: v < target - AI_HYST ? 1 : 0,
    brake: v > target + AI_HYST ? 1 : 0,
    dir: 1,
    mu,
    emergency: false,
  };
}

// ── the multi-train tick (order-independent — HLD §3.7) ───────────────────────

export interface TrainRecord {
  id: string;
  path: Path;
  pos: TrainPosition;
  state: SimState;
  spec: TrainSpec;
  kind: "player" | "ai";
  /** Stations this train serves (its booked stops are assumed made), so their
   *  starters clear for it. Block tokens still gate it via aspectSource. Unused
   *  for the player (driven by playerInputs, not aiInputs). Empty for a train
   *  whose path carries no station starters (e.g. the synthetic testbed). */
  served: ReadonlySet<string>;
}

/** Distance from the train to the next signal post AHEAD on its CURRENT edge, or
 *  +Infinity if none (cross-edge look-ahead is a non-goal). */
function distToSignalAhead(graph: TrackGraph, r: TrainRecord): number {
  const edge = graph.edges[r.pos.edgeId] as Edge;
  const n = nextSignalAhead(edge.route, r.state.chainage, 1);
  return n ? n.sig.chainage - r.state.chainage : Infinity;
}

/** The aspect of the next signal AHEAD on the train's CURRENT edge, GREEN if none.
 *  The AI's source is its served stations (its booked stops, so those starters
 *  clear) ∪ the clear-block tokens — so a station starter on the AI's path does
 *  NOT hold it, only an occupied block does. */
function aspectAheadFor(
  graph: TrackGraph,
  r: TrainRecord,
  blockEdgeIds: readonly string[],
  occByOthers: ReadonlySet<string>,
): Aspect {
  const edge = graph.edges[r.pos.edgeId] as Edge;
  const n = nextSignalAhead(edge.route, r.state.chainage, 1);
  if (!n) return "GREEN";
  return aspectAt(edge.route, n.i, aspectSource(r.served, blockEdgeIds, occByOthers));
}

/**
 * Advance every train one tick. Occupancy/signals are sampled ONCE from the
 * frame-N (pre-move) positions, then every train advances on the shared `dt`.
 * The single pre-move snapshot is what makes the tick permutation-invariant
 * (MT1) — set operations are order-independent and no train sees another's
 * partially-advanced state. The player is driven by `playerInputs`; each AI by
 * its own `aiInputs`.
 */
export function tickAll(
  graph: TrackGraph,
  records: TrainRecord[],
  blockEdgeIds: readonly string[],
  dt: number,
  mu: number,
  playerInputs: SimInputs,
): TrainRecord[] {
  const occ = occupiedEdges(records); // ONE frame-N snapshot
  return records.map((r) => {
    const occByOthers = new Set([...occ].filter((e) => e !== r.pos.edgeId));
    const inputs =
      r.kind === "player"
        ? playerInputs
        : aiInputs(
            graph.edges[r.pos.edgeId] as Edge,
            r.state,
            aspectAheadFor(graph, r, blockEdgeIds, occByOthers),
            distToSignalAhead(graph, r),
            r.spec,
            mu,
          );
    const res = stepOnGraph(graph, r.path, r.spec, r.state, r.pos, inputs, dt);
    return { ...r, state: res.state, pos: res.pos };
  });
}
