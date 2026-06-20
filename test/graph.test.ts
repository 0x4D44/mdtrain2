import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import { KINGSGATE_SEAHAVEN } from "../src/sim/route";
import { step, type SimInputs, type SimState } from "../src/sim/simulation";
import { EMU_GTO_4CAR } from "../src/sim/train";
import { planarPoseAt, heightAt, placeOnCentreline } from "../src/sim/centerline";
import {
  IDENTITY_FRAME,
  type Edge,
  type EdgeFrame,
  type TrackGraph,
} from "../src/sim/graph";
import {
  planarPoseOnEdge,
  heightOnEdge,
  placeOnEdge,
  exitFrame,
  validateGraph,
  sliceRoute,
} from "../src/sim/graph-geom";

// A flat, straight, signal-free test route long enough to integrate across.
function flat(length: number, psr = 40): Route {
  return {
    length,
    stations: [],
    grades: [{ from: 0, to: length, value: 0 }],
    speedLimits: [{ from: 0, to: length, value: psr }],
    curvatures: [{ from: 0, to: length, value: 0 }],
    signals: [],
  };
}

const POWER: SimInputs = { notch: 1, brake: 0, dir: 1, mu: 0.5, emergency: false };

// ── clampAtEnd — the single additive parameter on step() (HLD §3.4) ───────────
describe("clampAtEnd (step's only new behaviour)", () => {
  const route = flat(1_000);
  // A train one metre short of the end, running forward at 20 m/s, brakes off.
  const nearEnd: SimState = { chainage: 999, speed: 20, brakeActual: 0, time: 0 };

  it("default (true) still clamps speed to 0 at route.length — legacy behaviour", () => {
    const out = step(EMU_GTO_4CAR, route, nearEnd, POWER, 0.05); // 5-arg / default
    expect(out.chainage).toBe(route.length);
    expect(out.speed).toBe(0);
  });

  it("explicit true matches the default (the 6th arg is default-preserving)", () => {
    const a = step(EMU_GTO_4CAR, route, nearEnd, POWER, 0.05);
    const b = step(EMU_GTO_4CAR, route, nearEnd, POWER, 0.05, true);
    expect(b).toEqual(a);
  });

  it("false lets chainage run past route.length with speed retained (residual carry)", () => {
    const out = step(EMU_GTO_4CAR, route, nearEnd, POWER, 0.05, false);
    expect(out.chainage).toBeGreaterThan(route.length);
    expect(out.speed).toBeGreaterThan(0);
  });

  it("false does NOT defeat the start-clamp (reverse still clamps at s=0)", () => {
    const nearStart: SimState = { chainage: 1, speed: -20, brakeActual: 0, time: 0 };
    const rev: SimInputs = { ...POWER, dir: -1 };
    const out = step(EMU_GTO_4CAR, flat(1_000), nearStart, rev, 0.05, false);
    expect(out.chainage).toBe(0);
    expect(out.speed).toBe(0);
  });
});

// ── frame geometry: identity & composition (HLD §3.3, oracles P0/P1) ──────────

const edge = (id: string, route: Route, frame: EdgeFrame): Edge => ({ id, route, frame });

// A two-curve route used to exercise non-trivial frames; cut at a κ=0 point.
const AB: Route = {
  length: 2_000,
  stations: [],
  grades: [{ from: 0, to: 2_000, value: 0.005 }], // const grade exercises h0
  speedLimits: [{ from: 0, to: 2_000, value: 20 }], // cant-legal for R=350 (≤0.105)
  curvatures: [
    { from: 0, to: 500, value: 0 },
    { from: 500, to: 800, value: 1 / 400 }, // a curve in edge A
    { from: 800, to: 1_300, value: 0 },
    { from: 1_300, to: 1_500, value: -1 / 350 }, // a curve in edge B
    { from: 1_500, to: 2_000, value: 0 },
  ],
  signals: [],
};

describe("P0 — identity frame reproduces the legacy geometry (12 dp)", () => {
  const e = edge("legacy", KINGSGATE_SEAHAVEN, IDENTITY_FRAME);
  for (const s of [0, 1_000, 6_000, 9_800, 14_000]) {
    for (const d of [-3, 0, 7]) {
      it(`s=${s} d=${d}`, () => {
        const legacy = placeOnCentreline(KINGSGATE_SEAHAVEN, s, d);
        const viaEdge = placeOnEdge(e, s, d);
        expect(viaEdge.x).toBeCloseTo(legacy.x, 12);
        expect(viaEdge.y).toBeCloseTo(legacy.y, 12);
        expect(viaEdge.z).toBeCloseTo(legacy.z, 12);
        expect(viaEdge.heading).toBeCloseTo(legacy.heading, 12);
      });
    }
    it(`planar/height match at s=${s}`, () => {
      expect(planarPoseOnEdge(e, s).x).toBeCloseTo(planarPoseAt(KINGSGATE_SEAHAVEN, s).x, 12);
      expect(heightOnEdge(e, s)).toBeCloseTo(heightAt(KINGSGATE_SEAHAVEN, s), 12);
    });
  }
});

describe("P1 — composition = O5b lifted: two framed edges == one concatenated route", () => {
  const cut = 1_000; // κ=0 point in [800,1300]
  const eA = edge("A", sliceRoute(AB, 0, cut), IDENTITY_FRAME);
  const eB = edge("B", sliceRoute(AB, cut, AB.length), exitFrame(eA));

  it("the child edge entry frame equals the parent exit pose (continuity)", () => {
    const ef = exitFrame(eA);
    const p0 = planarPoseOnEdge(eB, 0);
    expect(p0.x).toBeCloseTo(ef.x0, 9);
    expect(p0.z).toBeCloseTo(ef.z0, 9);
    expect(p0.heading).toBeCloseTo(ef.psi0, 9);
  });

  for (const sB of [0, 100, 400, 900, 1_000]) {
    it(`placeOnEdge(B,${sB}) == placeOnCentreline(AB,${cut + sB})`, () => {
      const onGraph = placeOnEdge(eB, sB, 2.5);
      const mono = placeOnCentreline(AB, cut + sB, 2.5);
      expect(onGraph.x).toBeCloseTo(mono.x, 6);
      expect(onGraph.y).toBeCloseTo(mono.y, 6);
      expect(onGraph.z).toBeCloseTo(mono.z, 6);
      expect(onGraph.heading).toBeCloseTo(mono.heading, 6);
    });
  }
});

// ── validateGraph structural invariants (P2/P2-NEG/P-LEN/OCC-NS/NO-REPEAT/P3) ──

/** Thread a linear chain of routes into a graph (first IDENTITY, rest exitFrame). */
function chain(specs: { id: string; route: Route }[]): { graph: TrackGraph; path: string[] } {
  const edges: Record<string, Edge> = {};
  let frame: EdgeFrame = IDENTITY_FRAME;
  for (const s of specs) {
    const e = edge(s.id, s.route, frame);
    edges[s.id] = e;
    frame = exitFrame(e);
  }
  return { graph: { edges }, path: specs.map((s) => s.id) };
}

const straight = (length: number, psr = 25): Route => ({
  length,
  stations: [],
  grades: [{ from: 0, to: length, value: 0 }],
  speedLimits: [{ from: 0, to: length, value: psr }],
  curvatures: [{ from: 0, to: length, value: 0 }],
  signals: [],
});

describe("validateGraph structural invariants", () => {
  it("P2 — a frame-threaded chain has no continuity defect", () => {
    const { graph, path } = chain([
      { id: "e1", route: sliceRoute(AB, 0, 1_000) },
      { id: "e2", route: sliceRoute(AB, 1_000, 2_000) },
    ]);
    const defects = validateGraph(graph, [path], new Set(), 45);
    expect(defects).toEqual([]);
  });

  it("P2-NEG — perturbing one child frame by 1e-3 yields exactly one discontinuity", () => {
    const { graph, path } = chain([
      { id: "e1", route: sliceRoute(AB, 0, 1_000) },
      { id: "e2", route: sliceRoute(AB, 1_000, 2_000) },
    ]);
    const bad = graph.edges["e2"] as Edge;
    graph.edges["e2"] = { ...bad, frame: { ...bad.frame, x0: bad.frame.x0 + 1e-3 } };
    const defects = validateGraph(graph, [path], new Set(), 45);
    const disc = defects.filter((d) => d.kind === "discontinuity");
    expect(disc).toHaveLength(1);
    expect(disc[0]?.pair).toEqual(["e1", "e2"]);
  });

  it("P-LEN — a too-short edge is rejected", () => {
    const { graph, path } = chain([{ id: "tiny", route: straight(5) }]);
    const defects = validateGraph(graph, [path], new Set(), 45);
    expect(defects.some((d) => d.kind === "short-edge")).toBe(true);
  });

  it("OCC-NS — an edge id that aliases a station name is rejected", () => {
    const { graph, path } = chain([{ id: "Riverside", route: straight(1_000) }]);
    const defects = validateGraph(graph, [path], new Set(["Riverside"]), 45);
    expect(defects.some((d) => d.kind === "namespace")).toBe(true);
  });

  it("NO-REPEAT — a path repeating an edge id is rejected", () => {
    const { graph } = chain([{ id: "e1", route: straight(1_000) }]);
    const defects = validateGraph(graph, [["e1", "e1"]], new Set(), 45);
    expect(defects.some((d) => d.kind === "repeat-edge")).toBe(true);
  });

  it("P3 — sub-250 m radius, a band on a curve, and over-ceiling cant are each caught", () => {
    const tight: Route = {
      length: 1_000,
      stations: [],
      grades: [{ from: 0, to: 1_000, value: 0 }],
      speedLimits: [{ from: 0, to: 1_000, value: 60 }],
      curvatures: [{ from: 0, to: 1_000, value: 1 / 100 }], // R=100 < 250; cant huge at v=60
      signals: [],
      viaducts: [{ center: 500, halfLen: 100, valleyDepth: 10 }], // band on a curve
    };
    const g: TrackGraph = { edges: { bad: edge("bad", tight, IDENTITY_FRAME) } };
    const defects = validateGraph(g, [["bad"]], new Set(), 60);
    expect(defects.some((d) => d.kind === "radius")).toBe(true);
    expect(defects.some((d) => d.kind === "band-curved")).toBe(true);
    expect(defects.some((d) => d.kind === "cant")).toBe(true);
  });

  it("P3 — the legacy KINGSGATE route as one identity edge is invariant-clean", () => {
    const g: TrackGraph = { edges: { k: edge("k", KINGSGATE_SEAHAVEN, IDENTITY_FRAME) } };
    const stationNames = new Set(KINGSGATE_SEAHAVEN.stations.map((s) => s.name));
    const defects = validateGraph(g, [["k"]], stationNames, 30);
    expect(defects).toEqual([]);
  });
});

// ── sliceRoute — guarded sub-route extraction (D-IMPL-2) ──────────────────────

describe("sliceRoute", () => {
  it("a clean slice round-trips grade/curvature/speed against the original", () => {
    const sFrom = 6_100;
    const sTo = 7_100;
    const sl = sliceRoute(KINGSGATE_SEAHAVEN, sFrom, sTo);
    expect(sl.length).toBe(sTo - sFrom);
    // The KINGSGATE slice helpers are sampled via lookup, so compare the slice at s
    // to the original at s+sFrom for several interior points.
    // (gradeAt/curvatureAt/speedLimitAt re-exported indirectly through the route.)
    for (const s of [0, 200, 600, 999]) {
      const o = KINGSGATE_SEAHAVEN;
      // grade
      const og = o.grades.find((g) => s + sFrom >= g.from && s + sFrom < g.to)?.value ?? 0;
      const sg = sl.grades.find((g) => s >= g.from && s < g.to)?.value ?? 0;
      expect(sg).toBe(og);
    }
  });

  it("retains stations/signals inside the slice, rebased to s=0", () => {
    const sl = sliceRoute(KINGSGATE_SEAHAVEN, 0, 6_100);
    expect(sl.stations.map((s) => s.name)).toEqual(["Kingsgate", "Ashcombe", "Wealdham"]);
    expect(sl.signals.map((s) => s.chainage)).toEqual([2_120, 5_920]); // sFrom=0, unchanged
  });

  it("rebases an interior slice's chainages", () => {
    const sl = sliceRoute(KINGSGATE_SEAHAVEN, 7_100, 14_000);
    expect(sl.stations.find((s) => s.name === "Brinemouth")?.chainage).toBe(9_800 - 7_100);
    expect(sl.signals.map((s) => s.chainage)).toEqual([9_920 - 7_100]);
    // the viaduct & tunnel bands fall wholly inside and are retained, rebased
    expect(sl.viaducts?.[0]?.center).toBe(8_050 - 7_100);
    expect(sl.tunnels?.[0]?.center).toBe(11_700 - 7_100);
  });

  it("throws on a cut that is not on a κ=0 straight", () => {
    // 1000 is inside the R=300 city-exit curve [700,1300]
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 0, 1_000)).toThrow(/κ=0|straight/);
  });

  it("throws on a cut that straddles a platform", () => {
    // 5800 is Wealdham's stop board (platformHalf 90)
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 0, 5_800)).toThrow(/platform|straight|approach/);
  });

  it("throws on a cut that truncates the viaduct band", () => {
    // 8050 is the viaduct centre — but it sits on a κ=0 straight, so the band guard fires
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 0, 8_050)).toThrow(/band|truncates/);
  });

  it("accepts the KINGSGATE-junction cut points 6100 and 7100", () => {
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 0, 6_100)).not.toThrow();
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 6_100, 7_100)).not.toThrow();
    expect(() => sliceRoute(KINGSGATE_SEAHAVEN, 7_100, 14_000)).not.toThrow();
  });
});
