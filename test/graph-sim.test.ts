import { describe, it, expect } from "vitest";
import type { Aspect, Route } from "../src/sim/route";
import { aspectAt, nextSignalAhead } from "../src/sim/route";
import { step, createInitialState, type SimInputs, type SimState } from "../src/sim/simulation";
import { KINGSGATE_SEAHAVEN } from "../src/sim/route";
import { EMU_GTO_4CAR } from "../src/sim/train";
import { IDENTITY_FRAME, type Edge, type TrackGraph } from "../src/sim/graph";
import { exitFrame, validateGraph } from "../src/sim/graph-geom";
import {
  occupiedEdges,
  aspectSource,
  aiInputs,
  brakingCurveCeiling,
  stepOnGraph,
  tickAll,
  AI_HYST,
  AI_BRAKE_MARGIN,
  type TrainRecord,
} from "../src/sim/graph-sim";
import {
  SYNTHETIC_TESTBED,
  KINGSGATE_JUNCTION,
  type Scenario,
} from "../src/sim/testbed";

const edge = (id: string, route: Route, frame = IDENTITY_FRAME): Edge => ({ id, route, frame });

const straight = (length: number, psr = 25, signals: Route["signals"] = []): Route => ({
  length,
  stations: [],
  grades: [{ from: 0, to: length, value: 0 }],
  speedLimits: [{ from: 0, to: length, value: psr }],
  curvatures: [{ from: 0, to: length, value: 0 }],
  signals,
});

const MU = 0.5;

// ── occupancy (OCC1–OCC3) ─────────────────────────────────────────────────────

describe("occupancy — physical clear-block tokens folded into the cascade", () => {
  it("OCC1 — occupiedEdges returns exactly each train's current edge", () => {
    const occ = occupiedEdges([
      { id: "p", pos: { edgeId: "E_main_out", s: 10, d: 0 } },
      { id: "a", pos: { edgeId: "E_loop", s: 5, d: 0 } },
    ]);
    expect(occ).toEqual(new Set(["E_main_out", "E_loop"]));
  });

  // A loop-exit starter that protects the shared onward block "E_main_out".
  const loop = straight(500, 25, [{ chainage: 410, protects: "E_main_out" }]);

  it("OCC2 — while another train occupies the block, the loop-exit starter is RED", () => {
    const held = aspectSource(new Set(), ["E_main_out"], new Set(["E_main_out"]));
    expect(aspectAt(loop, 0, held)).toBe("RED"); // token absent ⇒ RED via the unchanged cascade
  });

  it("OCC3 — when the block clears, the token reappears and the starter clears", () => {
    const clear = aspectSource(new Set(), ["E_main_out"], new Set());
    expect(aspectAt(loop, 0, clear)).toBe("GREEN"); // token present, nothing ahead ⇒ GREEN
  });
});

// ── reactive AI (AI1–AI3) ─────────────────────────────────────────────────────

describe("reactive AI controller", () => {
  it("brakingCurveCeiling is √(2·a·(d−margin)) for RED and unbounded otherwise", () => {
    expect(brakingCurveCeiling("RED", 200, EMU_GTO_4CAR)).toBeCloseTo(
      Math.sqrt(2 * EMU_GTO_4CAR.brakeServiceDecel * (200 - AI_BRAKE_MARGIN)),
      9,
    );
    expect(brakingCurveCeiling("RED", AI_BRAKE_MARGIN - 5, EMU_GTO_4CAR)).toBe(0); // inside the margin
    expect(brakingCurveCeiling("GREEN", 200, EMU_GTO_4CAR)).toBe(Infinity);
    expect(brakingCurveCeiling("YELLOW", 50, EMU_GTO_4CAR)).toBe(Infinity);
  });

  it("AI1 — on a clear edge the AI tracks the PSR (settles within ~hysteresis)", () => {
    const psr = 20;
    const e = edge("E", straight(6_000, psr));
    const graph: TrackGraph = { edges: { E: e } };
    let state: SimState = { chainage: 0, speed: 0, brakeActual: 0, time: 0 };
    let pos = { edgeId: "E", s: 0, d: 0 };
    for (let n = 0; n < 2_000; n++) {
      const inputs = aiInputs(e, state, "GREEN", Infinity, EMU_GTO_4CAR, MU);
      const res = stepOnGraph(graph, ["E"], EMU_GTO_4CAR, state, pos, inputs, 0.05);
      state = res.state;
      pos = res.pos;
    }
    expect(state.speed).toBeGreaterThan(psr - AI_HYST - 1);
    expect(state.speed).toBeLessThan(psr + AI_HYST + 1);
  });

  it("AI2 — facing a RED post the AI brakes to a stand at or before it", () => {
    const postS = 1_000;
    const e = edge("E", straight(2_000, 25, [{ chainage: postS, protects: "BLOCK" }]));
    const graph: TrackGraph = { edges: { E: e } };
    let state: SimState = { chainage: 0, speed: 20, brakeActual: 0, time: 0 };
    let pos = { edgeId: "E", s: 0, d: 0 };
    for (let n = 0; n < 4_000 && state.speed > 0.05; n++) {
      const dist = postS - state.chainage;
      const inputs = aiInputs(e, state, "RED", dist, EMU_GTO_4CAR, MU);
      const res = stepOnGraph(graph, ["E"], EMU_GTO_4CAR, state, pos, inputs, 0.05);
      state = res.state;
      pos = res.pos;
    }
    expect(state.speed).toBeLessThan(0.2);
    expect(state.chainage).toBeLessThanOrEqual(postS + 1); // at or (just) before the post
    expect(state.chainage).toBeGreaterThan(postS - 60); // and not stopping absurdly early
  });

  it("AI3 — flipping the aspect to GREEN makes the AI latch power and accelerate away", () => {
    const e = edge("E", straight(2_000, 25, [{ chainage: 1_000, protects: "BLOCK" }]));
    const graph: TrackGraph = { edges: { E: e } };
    // a standing train short of the post
    let state: SimState = { chainage: 950, speed: 0, brakeActual: 1, time: 0 };
    let pos = { edgeId: "E", s: 950, d: 0 };
    for (let n = 0; n < 80; n++) {
      const inputs = aiInputs(e, state, "GREEN", 1_000 - state.chainage, EMU_GTO_4CAR, MU);
      const res = stepOnGraph(graph, ["E"], EMU_GTO_4CAR, state, pos, inputs, 0.05);
      state = res.state;
      pos = res.pos;
    }
    expect(state.speed).toBeGreaterThan(AI_HYST); // truly latched notch, not a trickle
    expect(state.chainage).toBeGreaterThan(951); // and actually moved off
  });

  it("cross-edge non-goal: the AI does NOT brake for a red on the NEXT edge (only its current one)", () => {
    // edge A carries no signals; edge B carries a starter protecting an OCCUPIED
    // block, so B's signal is RED — but a train on A cannot see it (HLD §1.2).
    const eA = edge("A", straight(500, 25));
    const eB = edge("B", straight(500, 25, [{ chainage: 80, protects: "blk" }]), exitFrame(eA));
    const eBlk = edge("blk", straight(500, 25), exitFrame(eB));
    const graph: TrackGraph = { edges: { A: eA, B: eB, blk: eBlk } };
    const block = ["blk"];
    // a stationary train sitting in the block keeps B's starter RED
    const recs: TrainRecord[] = [
      { id: "t", path: ["A", "B", "blk"], pos: { edgeId: "A", s: 350, d: 0 },
        state: { chainage: 350, speed: 12, brakeActual: 0, time: 0 }, spec: EMU_GTO_4CAR, kind: "ai", served: new Set() },
      { id: "blocker", path: ["blk"], pos: { edgeId: "blk", s: 50, d: 0 },
        state: { chainage: 50, speed: 0, brakeActual: 1, time: 0 }, spec: EMU_GTO_4CAR, kind: "ai", served: new Set() },
    ];
    let cur = recs;
    const onA = find(cur, "t").state.speed;
    // step a few ticks while "t" is still on A
    for (let n = 0; n < 10; n++) cur = tickAll(graph, cur, block, 0.05, MU, FULL_POWER);
    const t = find(cur, "t");
    expect(t.pos.edgeId).toBe("A"); // still on A
    expect(t.state.speed).toBeGreaterThan(onA); // accelerated — did NOT brake for B's red
  });
});

// ── multi-train tick order-independence (MT1) ─────────────────────────────────

describe("MT1 — tickAll is permutation-invariant", () => {
  // player on the through road, AI looped behind the shared block E_out.
  const eIn = edge("E_in", straight(800, 30));
  const eThru = edge("E_thru", straight(600, 30), exitFrame(eIn));
  const eLoop = edge("E_loop", straight(650, 25, [{ chainage: 600, protects: "E_out" }]), exitFrame(eIn));
  const eOut = edge("E_out", straight(800, 30), exitFrame(eThru));
  const graph: TrackGraph = { edges: { E_in: eIn, E_thru: eThru, E_loop: eLoop, E_out: eOut } };
  const block = ["E_out"];
  const playerInputs: SimInputs = { notch: 1, brake: 0, dir: 1, mu: MU, emergency: false };

  const records = (): TrainRecord[] => [
    {
      id: "player",
      path: ["E_in", "E_thru", "E_out"],
      pos: { edgeId: "E_thru", s: 100, d: 0 },
      state: { chainage: 100, speed: 22, brakeActual: 0, time: 0 },
      spec: EMU_GTO_4CAR,
      kind: "player",
      served: new Set(),
    },
    {
      id: "ai",
      path: ["E_in", "E_loop", "E_out"],
      pos: { edgeId: "E_loop", s: 400, d: 6 },
      state: { chainage: 400, speed: 18, brakeActual: 0, time: 0 },
      spec: EMU_GTO_4CAR,
      kind: "ai",
      served: new Set(),
    },
  ];

  it("any record permutation yields identical post-tick (edgeId, s, speed)", () => {
    const fwd = tickAll(graph, records(), block, 0.05, MU, playerInputs);
    const rev = tickAll(graph, [...records()].reverse(), block, 0.05, MU, playerInputs);
    const key = (rs: TrainRecord[], id: string): [string, number, number] => {
      const r = rs.find((x) => x.id === id) as TrainRecord;
      return [r.pos.edgeId, r.pos.s, r.state.speed];
    };
    expect(key(rev, "player")).toEqual(key(fwd, "player"));
    expect(key(rev, "ai")).toEqual(key(fwd, "ai"));
  });
});

// ── the headline scenarios (S1/S2) + validateGraph on both graphs ─────────────

const FULL_POWER: SimInputs = { notch: 1, brake: 0, dir: 1, mu: MU, emergency: false };
const find = (rs: TrainRecord[], id: string): TrainRecord => rs.find((r) => r.id === id) as TrainRecord;

/** The aspect the looped AI's loop-exit starter shows this frame (recomputed from
 *  the pre-move snapshot, exactly as tickAll's AI sees it). null if not applicable. */
function loopExitAspect(scn: Scenario, recs: TrainRecord[], loopEdgeId: string): Aspect | null {
  const ai = find(recs, "ai1");
  if (ai.pos.edgeId !== loopEdgeId) return null;
  const occ = occupiedEdges(recs.map((r) => ({ id: r.id, pos: r.pos })));
  const occByOthers = new Set([...occ].filter((e) => e !== loopEdgeId));
  const route = (scn.graph.edges[loopEdgeId] as Edge).route;
  const n = nextSignalAhead(route, ai.state.chainage, 1);
  if (!n) return null;
  return aspectAt(route, n.i, aspectSource(new Set(), scn.blockEdgeIds, occByOthers));
}

describe("validateGraph accepts both scenario graphs", () => {
  it("the synthetic testbed is invariant-clean (incl. the merge: both parents share E_main_out)", () => {
    const s = SYNTHETIC_TESTBED;
    expect(validateGraph(s.graph, Object.values(s.paths), s.stationNames, s.maxSpeed)).toEqual([]);
  });

  it("the KINGSGATE junction is invariant-clean (decomposed real route + loop + branch)", () => {
    const s = KINGSGATE_JUNCTION;
    expect(validateGraph(s.graph, Object.values(s.paths), s.stationNames, s.maxSpeed, 120)).toEqual([]);
  });
});

describe("S1 — the player delays AND overtakes a looped AI (synthetic testbed)", () => {
  it("the looped AI is held RED in the loop while the player occupies the onward block, then resumes", () => {
    const scn = SYNTHETIC_TESTBED;
    let recs = scn.makeRecords();
    let heldFired = false; // non-vacuity: the delay genuinely happened
    let resumedAfterHold = false;

    for (let n = 0; n < 9_000; n++) {
      const aspect = loopExitAspect(scn, recs, "E_loop");
      const ai = find(recs, "ai1");
      const player = find(recs, "player");
      // NON-VACUITY: ∃ a tick with loop-exit RED ∧ AI ~stopped ∧ player ON the block.
      if (aspect === "RED" && Math.abs(ai.state.speed) < 0.3 && player.pos.edgeId === "E_main_out") {
        heldFired = true;
      }
      // RELEASE: the AI is moving again on the onward block after the hold.
      if (heldFired && ai.pos.edgeId === "E_main_out" && ai.state.speed > 1) {
        resumedAfterHold = true;
      }
      recs = tickAll(scn.graph, recs, scn.blockEdgeIds, 0.05, MU, FULL_POWER);
    }

    expect(heldFired).toBe(true); // the player provably delayed the AI
    expect(resumedAfterHold).toBe(true); // and the AI resumed once the block cleared
    expect(find(recs, "player").pos.edgeId).toBe("E_main_buffer"); // player completed (overtook)
    const ai1 = find(recs, "ai1");
    expect(ai1.pos.edgeId).toBe("E_main_buffer"); // AI completed its booked path
    expect(Math.abs(ai1.state.speed)).toBeLessThan(0.5);
  });
});

describe("S2 — branch divergence (synthetic testbed)", () => {
  it("the branch AI diverges at the throat and runs to its buffer", () => {
    const scn = SYNTHETIC_TESTBED;
    let recs = scn.makeRecords();
    for (let n = 0; n < 9_000; n++) {
      recs = tickAll(scn.graph, recs, scn.blockEdgeIds, 0.05, MU, FULL_POWER);
    }
    const ai2 = find(recs, "ai2");
    expect(ai2.pos.edgeId).toBe("E_branch_buffer");
    expect(Math.abs(ai2.state.speed)).toBeLessThan(0.5);
    // the branch visibly departs the main: its entry heading differs from the through's
    const branchPsi = exitFrame(scn.graph.edges["E_branch"] as Edge).psi0;
    const mainPsi = exitFrame(scn.graph.edges["E_main_through"] as Edge).psi0;
    expect(Math.abs(branchPsi - mainPsi)).toBeGreaterThan(0.2);
    // validateGraph passes for the branch path alone
    expect(validateGraph(scn.graph, [scn.paths.ai2 as string[]], scn.stationNames, scn.maxSpeed)).toEqual([]);
  });
});

// ── the live KINGSGATE junction end-to-end (the oracle review C1 was missing) ──

describe("KINGSGATE junction: the reactive AIs traverse the real route, not freeze at a station", () => {
  it("ai1 clears the real station starters, diverges onto the loop; ai2 runs the branch to its buffer", () => {
    const scn = KINGSGATE_JUNCTION;
    let recs = scn.makeRecords();
    const drive: SimInputs = { notch: 1, brake: 0, dir: 1, mu: MU, emergency: false };
    let ai1EverPastApproach = false;
    for (let n = 0; n < 9_000; n++) {
      recs = tickAll(scn.graph, recs, scn.blockEdgeIds, 0.05, MU, drive);
      if (find(recs, "ai1").pos.edgeId !== "K_approach") ai1EverPastApproach = true;
    }
    const ai1 = find(recs, "ai1");
    const ai2 = find(recs, "ai2");
    // C1 regression guard: the AIs MUST get past K_approach — a freeze at the
    // Ashcombe starter (~2070) would leave them on K_approach forever.
    expect(ai1EverPastApproach).toBe(true);
    expect(["K_loop", "K_onward"]).toContain(ai1.pos.edgeId);
    // The branch AI completes its booked path to the buffer.
    expect(ai2.pos.edgeId).toBe("K_branch_buffer");
    expect(Math.abs(ai2.state.speed)).toBeLessThan(0.5);
    // The player drove the whole route to the Seahaven terminus.
    expect(find(recs, "player").pos.edgeId).toBe("K_onward");
  });
});

// ── live-wiring faithfulness: the KINGSGATE-junction player == KINGSGATE direct ─

describe("KINGSGATE-junction player reproduces driving KINGSGATE_SEAHAVEN directly", () => {
  it("global chainage and speed match step()-on-KINGSGATE across both joins (the cuts are constant-grade, κ=0)", () => {
    const scn = KINGSGATE_JUNCTION;
    const path = scn.paths.player as string[];
    const offsets: Record<string, number> = {};
    let acc = 0;
    for (const id of path) {
      offsets[id] = acc;
      acc += (scn.graph.edges[id] as Edge).route.length;
    }

    // graph player: a single record on the player path, from the route start.
    let rec: TrainRecord = {
      id: "player",
      path,
      pos: { edgeId: path[0] as string, s: 0, d: 0 },
      state: createInitialState(0),
      spec: EMU_GTO_4CAR,
      kind: "player",
      served: new Set(),
    };
    // KINGSGATE direct.
    let mono: SimState = createInitialState(0);
    const drive: SimInputs = { notch: 1, brake: 0, dir: 1, mu: MU, emergency: false };

    for (let n = 0; n < 6_000; n++) {
      rec = tickAll(scn.graph, [rec], scn.blockEdgeIds, 0.05, MU, drive)[0] as TrainRecord;
      mono = step(EMU_GTO_4CAR, KINGSGATE_SEAHAVEN, mono, drive, 0.05);
      const globalS = (offsets[rec.pos.edgeId] as number) + rec.pos.s;
      expect(globalS).toBeCloseTo(mono.chainage, 6);
      expect(rec.state.speed).toBeCloseTo(mono.speed, 6);
    }
    // it really crossed both junction joins onto the onward edge
    expect(rec.pos.edgeId).toBe("K_onward");
  });
});
