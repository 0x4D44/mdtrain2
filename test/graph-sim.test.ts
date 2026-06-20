import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import { aspectAt } from "../src/sim/route";
import type { SimInputs, SimState } from "../src/sim/simulation";
import { EMU_GTO_4CAR } from "../src/sim/train";
import { IDENTITY_FRAME, type Edge, type TrackGraph } from "../src/sim/graph";
import { exitFrame } from "../src/sim/graph-geom";
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

  it("AI3 — flipping the aspect to GREEN makes the AI accelerate again", () => {
    const e = edge("E", straight(2_000, 25, [{ chainage: 1_000, protects: "BLOCK" }]));
    const graph: TrackGraph = { edges: { E: e } };
    // a slow/standing train short of the post
    let state: SimState = { chainage: 950, speed: 0, brakeActual: 1, time: 0 };
    let pos = { edgeId: "E", s: 950, d: 0 };
    const before = state.speed;
    for (let n = 0; n < 40; n++) {
      const inputs = aiInputs(e, state, "GREEN", 1_000 - state.chainage, EMU_GTO_4CAR, MU);
      const res = stepOnGraph(graph, ["E"], EMU_GTO_4CAR, state, pos, inputs, 0.05);
      state = res.state;
      pos = res.pos;
    }
    expect(state.speed).toBeGreaterThan(before);
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
    },
    {
      id: "ai",
      path: ["E_in", "E_loop", "E_out"],
      pos: { edgeId: "E_loop", s: 400, d: 6 },
      state: { chainage: 400, speed: 18, brakeActual: 0, time: 0 },
      spec: EMU_GTO_4CAR,
      kind: "ai",
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
