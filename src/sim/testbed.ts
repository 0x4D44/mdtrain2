// Scenario DATA (HLD §6 + kickoff decision D-IMPL-2): two track graphs built on
// the engine. (1) The SYNTHETIC TESTBED — the smallest graph with a real passing
// loop, a branch, and exactly the physical-occupancy interaction S1/S2 need; the
// oracle fixture. (2) The KINGSGATE JUNCTION — the real 14 km KINGSGATE_SEAHAVEN
// route decomposed by the guarded `sliceRoute` into edges, with a passing loop +
// a branch + reactive AI spliced into the [5500,9200] κ=0 straight; the live
// default. Pure data: imports route/centerline/graph/graph-geom (NOT fenced — it
// is scenario authoring, like the existing route literals).

import type { Route, Signal } from "./route";
import { KINGSGATE_SEAHAVEN } from "./route";
import { heightAt } from "./centerline";
import {
  IDENTITY_FRAME,
  type Edge,
  type EdgeFrame,
  type TrackGraph,
  type Path,
} from "./graph";
import { exitFrame, sliceRoute } from "./graph-geom";
import type { TrainRecord } from "./graph-sim";
import { EMU_GTO_4CAR } from "./train";

const MPH = 0.44704;

// ── small route builders (hand-authored Route literals) ───────────────────────

const mkEdge = (id: string, route: Route, frame: EdgeFrame): Edge => ({ id, route, frame });

/** A straight, level edge route of `length` m at posted limit `psr` (m/s),
 *  optionally carrying a grade and signals. */
function straightRoute(
  length: number,
  psr: number,
  opts: { grade?: number; signals?: Signal[] } = {},
): Route {
  const grade = opts.grade ?? 0;
  return {
    length,
    stations: [],
    grades: [{ from: 0, to: length, value: grade }],
    speedLimits: [{ from: 0, to: length, value: psr }],
    curvatures: [{ from: 0, to: length, value: 0 }],
    signals: opts.signals ?? [],
  };
}

/**
 * A passing-loop route whose LOCAL geometry ends exactly at (x=0, z=`zTarget`,
 * heading=0) — matching a straight through-edge of length `zTarget`, so the loop
 * and the through share a merge frame (P2 holds by construction). Shape: the
 * symmetric arc sequence [+κ,Lc][−κ,Lc][straight Ls][−κ,Lc][+κ,Lc]; by symmetry
 * the lateral offset and heading both return to 0 and z = 4·sinθ/κ + Ls, so
 * `Ls = zTarget − 4·sinθ/κ`. A constant grade gives total height drop `hDrop`
 * (matching the through edge's drop) so the merge is also height-continuous. The
 * loop-exit starter sits on the middle straight, just before the rejoin curve.
 */
function makeLoopRoute(
  kappa: number,
  theta: number,
  zTarget: number,
  hDrop: number,
  psr: number,
  protects: string,
): Route {
  const Lc = theta / kappa;
  const Ls = zTarget - (4 * Math.sin(theta)) / kappa;
  if (Ls <= 0) throw new Error(`makeLoopRoute: Ls=${Ls} ≤ 0 — reduce θ or raise zTarget`);
  const length = 4 * Lc + Ls;
  const signalChainage = length - 2 * Lc - 5; // on the middle straight, before the rejoin
  return {
    length,
    stations: [],
    grades: [{ from: 0, to: length, value: hDrop / length }],
    speedLimits: [{ from: 0, to: length, value: psr }],
    curvatures: [
      { from: 0, to: Lc, value: kappa },
      { from: Lc, to: 2 * Lc, value: -kappa },
      { from: 2 * Lc, to: 2 * Lc + Ls, value: 0 },
      { from: 2 * Lc + Ls, to: 3 * Lc + Ls, value: -kappa },
      { from: 3 * Lc + Ls, to: length, value: kappa },
    ],
    signals: [{ chainage: signalChainage, protects }],
  };
}

/** A diverging branch: one opening curve (κ over angle θ) then a straight run to
 *  a buffer. Diverges from its node and never rejoins. */
function makeBranchRoute(kappa: number, theta: number, straightLen: number, psr: number): Route {
  const Lc = theta / Math.abs(kappa);
  const length = Lc + straightLen;
  return {
    length,
    stations: [],
    grades: [{ from: 0, to: length, value: 0 }],
    speedLimits: [{ from: 0, to: length, value: psr }],
    curvatures: [
      { from: 0, to: Lc, value: kappa },
      { from: Lc, to: length, value: 0 },
    ],
    signals: [],
  };
}

// ── a Scenario: a graph + booked paths + the contended blocks + initial trains ──

export interface Scenario {
  id: string;
  graph: TrackGraph;
  paths: Record<string, Path>;
  /** Edge ids that act as block tokens (occupied ⇒ the protecting starter REDs). */
  blockEdgeIds: string[];
  /** Station names (for OCC-NS — must stay disjoint from edge ids). */
  stationNames: ReadonlySet<string>;
  /** Max line speed for P-LEN, m/s. */
  maxSpeed: number;
  /** Fresh initial trains (player first), AI render offsets onto the loop/branch. */
  makeRecords(): TrainRecord[];
}

// ── (1) the synthetic testbed (oracle fixture — HLD §6) ───────────────────────

function buildSyntheticTestbed(): Scenario {
  // A slow line throughout (loop speed): the AI cannot see the loop-exit signal
  // until it is ON the loop (cross-edge look-ahead is a non-goal), so the whole
  // testbed runs at passing-loop speed and the AI can always brake to the hold —
  // exactly how a real slow loop is signalled. (The KINGSGATE loop is long
  // enough to absorb a faster approach; this abstract fixture stays compact.)
  const PSR = 25 * MPH;
  const eIn = mkEdge("E_main_in", straightRoute(800, PSR), IDENTITY_FRAME);
  const fNode = exitFrame(eIn); // the throat (diverge node)
  const eThrough = mkEdge("E_main_through", straightRoute(400, PSR), fNode);
  const eLoop = mkEdge(
    "E_loop",
    makeLoopRoute(1 / 600, 0.15, 400, 0, 25 * MPH, "E_main_out"),
    fNode,
  );
  const fMerge = exitFrame(eThrough); // == exitFrame(eLoop) by construction
  // A long shared onward block: the player (driven hard) occupies it across the
  // whole window in which the slow looped AI arrives at its loop-exit starter, so
  // the hold is robust rather than a knife-edge timing coincidence.
  const eOut = mkEdge("E_main_out", straightRoute(2_000, PSR), fMerge);
  const eMainBuf = mkEdge("E_main_buffer", straightRoute(150, 15 * MPH), exitFrame(eOut));
  const eBranch = mkEdge("E_branch", makeBranchRoute(-1 / 400, 0.35, 400, 40 * MPH), fNode);
  const eBranchBuf = mkEdge("E_branch_buffer", straightRoute(150, 15 * MPH), exitFrame(eBranch));

  const graph: TrackGraph = {
    edges: {
      E_main_in: eIn,
      E_main_through: eThrough,
      E_loop: eLoop,
      E_main_out: eOut,
      E_main_buffer: eMainBuf,
      E_branch: eBranch,
      E_branch_buffer: eBranchBuf,
    },
  };
  const paths: Record<string, Path> = {
    player: ["E_main_in", "E_main_through", "E_main_out", "E_main_buffer"],
    ai1: ["E_main_in", "E_loop", "E_main_out", "E_main_buffer"],
    ai2: ["E_main_in", "E_branch", "E_branch_buffer"],
  };
  return {
    id: "testbed",
    graph,
    paths,
    blockEdgeIds: ["E_main_out"],
    stationNames: new Set(),
    maxSpeed: 44.7,
    makeRecords: () => [
      mkRecord("player", paths.player as Path, "E_main_in", 700, 12, 0, "player"),
      mkRecord("ai1", paths.ai1 as Path, "E_main_in", 80, 12, 6, "ai"),
      mkRecord("ai2", paths.ai2 as Path, "E_main_in", 40, 12, -6, "ai"),
    ],
  };
}

// ── (2) the KINGSGATE junction (live default — D-IMPL-2) ──────────────────────

function buildKingsgateJunction(): Scenario {
  // Decompose the real route at clean κ=0 cut points (guarded by sliceRoute).
  const approachR = sliceRoute(KINGSGATE_SEAHAVEN, 0, 6_100);
  const throughR = sliceRoute(KINGSGATE_SEAHAVEN, 6_100, 7_100);
  const onwardR = sliceRoute(KINGSGATE_SEAHAVEN, 7_100, 14_000);
  const hDrop = heightAt(throughR, throughR.length); // the through edge's height change

  const approach = mkEdge("K_approach", approachR, IDENTITY_FRAME);
  const fNode = exitFrame(approach);
  const through = mkEdge("K_through", throughR, fNode);
  const loop = mkEdge(
    "K_loop",
    makeLoopRoute(1 / 600, 0.15, throughR.length, hDrop, 40 * MPH, "K_onward"),
    fNode,
  );
  const onward = mkEdge("K_onward", onwardR, exitFrame(through));
  const branch = mkEdge("K_branch", makeBranchRoute(-1 / 500, 0.4, 500, 40 * MPH), fNode);
  const branchBuf = mkEdge("K_branch_buffer", straightRoute(150, 15 * MPH), exitFrame(branch));

  const graph: TrackGraph = {
    edges: {
      K_approach: approach,
      K_through: through,
      K_loop: loop,
      K_onward: onward,
      K_branch: branch,
      K_branch_buffer: branchBuf,
    },
  };
  const paths: Record<string, Path> = {
    player: ["K_approach", "K_through", "K_onward"],
    ai1: ["K_approach", "K_loop", "K_onward"],
    ai2: ["K_approach", "K_branch", "K_branch_buffer"],
  };
  return {
    id: "kingsgate",
    graph,
    paths,
    blockEdgeIds: ["K_onward"],
    stationNames: new Set(KINGSGATE_SEAHAVEN.stations.map((s) => s.name)),
    maxSpeed: 44.7,
    // Player slightly ahead so it reaches the junction first; AIs follow. The human
    // drives the player, so this is a starting tableau, not a scripted overtake.
    makeRecords: () => [
      mkRecord("player", paths.player as Path, "K_approach", 220, 10, 0, "player"),
      mkRecord("ai1", paths.ai1 as Path, "K_approach", 120, 10, 6, "ai"),
      mkRecord("ai2", paths.ai2 as Path, "K_approach", 60, 10, -6, "ai"),
    ],
  };
}

function mkRecord(
  id: string,
  path: Path,
  edgeId: string,
  s: number,
  speed: number,
  d: number,
  kind: "player" | "ai",
): TrainRecord {
  return {
    id,
    path,
    pos: { edgeId, s, d },
    state: { chainage: s, speed, brakeActual: 0, time: 0 },
    spec: EMU_GTO_4CAR,
    kind,
  };
}

export const SYNTHETIC_TESTBED: Scenario = buildSyntheticTestbed();
export const KINGSGATE_JUNCTION: Scenario = buildKingsgateJunction();

/** Select the live scenario: `?scenario=testbed` → the synthetic graph, else the
 *  KINGSGATE junction (the default). */
export function scenarioById(id: string | null): Scenario {
  return id === "testbed" ? SYNTHETIC_TESTBED : KINGSGATE_JUNCTION;
}
