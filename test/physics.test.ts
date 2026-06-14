import { describe, it, expect } from "vitest";
import {
  acceleration,
  davisResistance,
  effectiveMass,
  tractiveEffort,
  G,
  type TrainSpec,
  type AccelInputs,
} from "../src/sim/physics";
import { EMU_GTO_4CAR, ADHESION } from "../src/sim/train";
import type { Route } from "../src/sim/route";
import { WESTFORD_EASTBANK } from "../src/sim/route";
import { createInitialState, step, type SimInputs, type SimState } from "../src/sim/simulation";

const flatRoute: Route = {
  length: 100_000,
  stations: [],
  grades: [{ from: 0, to: 100_000, value: 0 }],
  speedLimits: [{ from: 0, to: 100_000, value: 40 }],
  curvatures: [{ from: 0, to: 100_000, value: 0 }],
  signals: [],
};

function drive(
  state: SimState,
  inputs: SimInputs,
  seconds: number,
  spec = EMU_GTO_4CAR,
  route = flatRoute,
  dt = 1 / 60,
): SimState {
  let s = state;
  for (let t = 0; t < seconds; t += dt) s = step(spec, route, s, inputs, dt);
  return s;
}

describe("tractive effort curve", () => {
  it("is flat at the maximum below base speed", () => {
    const te = tractiveEffort(EMU_GTO_4CAR, 2, ADHESION.dry);
    expect(te).toBeCloseTo(EMU_GTO_4CAR.tractiveEffortMax, 0);
  });

  it("follows constant power above base speed", () => {
    const v = 30;
    const te = tractiveEffort(EMU_GTO_4CAR, v, ADHESION.dry);
    expect(te).toBeCloseTo(EMU_GTO_4CAR.powerMax / v, 0);
  });

  it("is capped by adhesion when railhead grip is low", () => {
    // At normal grip the unit's 120 kN ceiling is below the adhesion limit, so
    // adhesion doesn't bite. Drop μ low enough and it becomes the constraint.
    const lowMu = 0.05;
    const te = tractiveEffort(EMU_GTO_4CAR, 1, lowMu);
    const cap = lowMu * EMU_GTO_4CAR.adhesiveFraction * EMU_GTO_4CAR.mass * G;
    expect(te).toBeCloseTo(cap, 0);
    expect(te).toBeLessThan(EMU_GTO_4CAR.tractiveEffortMax);
    expect(tractiveEffort(EMU_GTO_4CAR, 1, 0.03)).toBeLessThan(te); // less grip ⇒ less effort
  });
});

describe("davis resistance", () => {
  it("is positive and strictly increasing with speed", () => {
    const r0 = davisResistance(EMU_GTO_4CAR, 0);
    const r20 = davisResistance(EMU_GTO_4CAR, 20);
    const r40 = davisResistance(EMU_GTO_4CAR, 40);
    expect(r0).toBeGreaterThan(0);
    expect(r20).toBeGreaterThan(r0);
    expect(r40).toBeGreaterThan(r20);
  });
});

describe("property: a braked train at a standstill never creeps", () => {
  it("stays at chainage 0 with brake applied and no power (level track)", () => {
    const start = createInitialState(0); // brakeActual = 1
    const end = drive(start, { notch: 0, brake: 1, dir: 1, mu: ADHESION.wetNight, emergency: false }, 30);
    expect(Math.abs(end.speed)).toBeLessThan(1e-6);
    expect(Math.abs(end.chainage)).toBeLessThan(1e-6);
  });

  it("also holds on a falling gradient", () => {
    // Eastbank approach falls at 1%; full brake must still hold it.
    const start: SimState = { chainage: 5_200, speed: 0, brakeActual: 1, time: 0 };
    const end = drive(start, { notch: 0, brake: 1, dir: 1, mu: ADHESION.wetNight, emergency: false }, 30, EMU_GTO_4CAR, WESTFORD_EASTBANK);
    expect(Math.abs(end.speed)).toBeLessThan(0.05);
    expect(Math.abs(end.chainage - 5_200)).toBeLessThan(1);
  });
});

describe("property: the reverser drives the correct way", () => {
  it("forward power increases chainage, reverse decreases it", () => {
    const fwd = drive({ chainage: 1_000, speed: 0, brakeActual: 0, time: 0 }, { notch: 1, brake: 0, dir: 1, mu: ADHESION.dry, emergency: false }, 10);
    const rev = drive({ chainage: 1_000, speed: 0, brakeActual: 0, time: 0 }, { notch: 1, brake: 0, dir: -1, mu: ADHESION.dry, emergency: false }, 10);
    expect(fwd.chainage).toBeGreaterThan(1_000);
    expect(fwd.speed).toBeGreaterThan(0);
    expect(rev.chainage).toBeLessThan(1_000);
    expect(rev.speed).toBeLessThan(0);
  });
});

describe("property: with no brake or power, a downhill train runs away", () => {
  it("accelerates down a falling gradient", () => {
    const start: SimState = { chainage: 5_000, speed: 0, brakeActual: 0, time: 0 };
    const end = drive(start, { notch: 0, brake: 0, dir: 1, mu: ADHESION.dry, emergency: false }, 15, EMU_GTO_4CAR, WESTFORD_EASTBANK);
    expect(end.speed).toBeGreaterThan(0.5);
    expect(end.chainage).toBeGreaterThan(5_000);
  });
});

describe("oracle: braking distance matches the analytic value", () => {
  it("stops in v²/(2a) with resistance removed", () => {
    // Strip Davis resistance so the only retarding force is the brake; then the
    // stop distance has a closed form to check the integrator against.
    const spec: TrainSpec = { ...EMU_GTO_4CAR, davisA: 0, davisB: 0, davisC: 0 };
    const v0 = 20;
    const decel = spec.brakeServiceDecel; // brake not adhesion-limited here
    const expected = (v0 * v0) / (2 * decel); // metres
    const start: SimState = { chainage: 0, speed: v0, brakeActual: 1, time: 0 };
    const end = drive(start, { notch: 0, brake: 1, dir: 1, mu: ADHESION.dry, emergency: false }, 40, spec);
    expect(end.speed).toBeLessThan(1e-3);
    expect(end.chainage).toBeGreaterThan(expected * 0.97);
    expect(end.chainage).toBeLessThan(expected * 1.03);
  });
});

describe("oracle: production integrator agrees with an independent RK4", () => {
  it("coast-down distance and speed match within tolerance", () => {
    const spec = EMU_GTO_4CAR;
    const inp: AccelInputs = { v: 0, notch: 0, brakeActual: 0, dir: 1, grade: 0, mu: ADHESION.dry, emergency: false };
    const T = 20;
    const h = 1 / 240;

    // Independent reference: RK4 on ds/dt=v, dv/dt=acceleration(...).
    let s = 0;
    let v = 25;
    const f = (vv: number) => acceleration(spec, { ...inp, v: vv });
    for (let t = 0; t < T; t += h) {
      const k1v = f(v), k1s = v;
      const k2v = f(v + 0.5 * h * k1v), k2s = v + 0.5 * h * k1v;
      const k3v = f(v + 0.5 * h * k2v), k3s = v + 0.5 * h * k2v;
      const k4v = f(v + h * k3v), k4s = v + h * k3v;
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      s += (h / 6) * (k1s + 2 * k2s + 2 * k3s + k4s);
    }

    const prod = drive({ chainage: 0, speed: 25, brakeActual: 0, time: 0 }, { notch: 0, brake: 0, dir: 1, mu: ADHESION.dry, emergency: false }, T, spec, flatRoute, h);
    expect(prod.speed).toBeCloseTo(v, 1);
    expect(Math.abs(prod.chainage - s) / s).toBeLessThan(0.005);
  });
});

describe("effectiveMass", () => {
  it("includes the rotational-inertia factor", () => {
    expect(effectiveMass(EMU_GTO_4CAR)).toBeCloseTo(160_000 * 1.08, 5);
  });
});
