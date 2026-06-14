import { describe, it, expect } from "vitest";
import { type TrainSpec } from "../src/sim/physics";
import { EMU_GTO_4CAR, ADHESION } from "../src/sim/train";
import type { Route } from "../src/sim/route";
import { WESTFORD_EASTBANK } from "../src/sim/route";
import { step, type SimInputs, type SimState } from "../src/sim/simulation";

const flatRoute: Route = {
  length: 100_000,
  stations: [],
  grades: [{ from: 0, to: 100_000, value: 0 }],
  speedLimits: [{ from: 0, to: 100_000, value: 40 }],
  curvatures: [{ from: 0, to: 100_000, value: 0 }],
};

// A synthetic, uniformly steep climbing grade — steep enough that a full-service
// hold slips but an emergency hold does not (the O21 force ordering below).
const steepRoute: Route = {
  length: 100_000,
  stations: [],
  grades: [{ from: 0, to: 100_000, value: 0.12 }],
  speedLimits: [{ from: 0, to: 100_000, value: 40 }],
  curvatures: [{ from: 0, to: 100_000, value: 0 }],
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

describe("oracle O1: emergency stop distance matches the analytic value", () => {
  it("stops in v²/(2·brakeEmergencyDecel) with resistance removed", () => {
    // Strip Davis so the only retarding force is the emergency brake; the stop
    // distance then has a closed form to check the integrator against.
    const spec: TrainSpec = { ...EMU_GTO_4CAR, davisA: 0, davisB: 0, davisC: 0 };
    const v0 = 20;
    const expected = (v0 * v0) / (2 * spec.brakeEmergencyDecel); // metres
    const start: SimState = { chainage: 0, speed: v0, brakeActual: 1, time: 0 };
    const end = drive(
      start,
      { notch: 0, brake: 1, dir: 1, emergency: true, mu: ADHESION.dry },
      40,
      spec,
    );
    expect(end.speed).toBeLessThan(1e-3);
    expect(end.chainage).toBeGreaterThan(expected * 0.97);
    expect(end.chainage).toBeLessThan(expected * 1.03);
  });
});

describe("oracle O2: emergency stops strictly shorter than service", () => {
  it("emergency stop distance < service, ratio ≈ serviceDecel/emergencyDecel", () => {
    const spec: TrainSpec = { ...EMU_GTO_4CAR, davisA: 0, davisB: 0, davisC: 0 };
    const v0 = 20;
    const start: SimState = { chainage: 0, speed: v0, brakeActual: 1, time: 0 };

    const service = drive(
      start,
      { notch: 0, brake: 1, dir: 1, emergency: false, mu: ADHESION.dry },
      40,
      spec,
    );
    const emergency = drive(
      start,
      { notch: 0, brake: 1, dir: 1, emergency: true, mu: ADHESION.dry },
      40,
      spec,
    );

    expect(service.speed).toBeLessThan(1e-3);
    expect(emergency.speed).toBeLessThan(1e-3);
    expect(emergency.chainage).toBeLessThan(service.chainage);

    // Stop distance ∝ 1/decel, so the ratio is serviceDecel/emergencyDecel.
    const expectedRatio = spec.brakeServiceDecel / spec.brakeEmergencyDecel; // 0.9/1.3
    expect(emergency.chainage / service.chainage).toBeCloseTo(expectedRatio, 2);
  });
});

describe("oracle O21: static-hold differential on a steep grade", () => {
  // Synthetic grade 0.12, μ = wetNight, at a stand, fully applied, no power.
  // Force balance (computed by hand, see HLD §4/O21):
  //   gravity      ≈ 188_288 N   (mass·G·grade)
  //   service hold ≈ 155_520 N   (brakeServiceDecel·meff)
  //   emergency    ≈ 224_640 N   (brakeEmergencyDecel·meff)
  //   adhesion cap ≈ 313_813 N   (μ·mass·G)  — not binding
  // ⇒ service SLIPS (gravity > service hold) but emergency HOLDS.
  const start: SimState = { chainage: 1_000, speed: 0, brakeActual: 1, time: 0 };

  it("service brake SLIPS — the train rolls back down the grade", () => {
    const end = drive(
      start,
      { notch: 0, brake: 1, dir: 1, emergency: false, mu: ADHESION.wetNight },
      10,
      EMU_GTO_4CAR,
      steepRoute,
    );
    expect(Math.abs(end.speed)).toBeGreaterThan(0.1);
  });

  it("emergency brake HOLDS — the train stays at a stand", () => {
    const end = drive(
      start,
      { notch: 0, brake: 1, dir: 1, emergency: true, mu: ADHESION.wetNight },
      10,
      EMU_GTO_4CAR,
      steepRoute,
    );
    expect(Math.abs(end.speed)).toBeLessThan(1e-3);
    expect(Math.abs(end.chainage - 1_000)).toBeLessThan(1e-3);
  });

  // Secondary sanity (HLD §4/O21): on the route's real steepest grade by
  // magnitude (+1.2% Riverside climb, gravity ≈ 18.8 kN ≪ both hold forces)
  // BOTH service and emergency hold — confirming the synthetic 0.12 grade is
  // the discriminating fixture, not the route itself.
  it("both service and emergency hold on the route's real 1.2% grade", () => {
    const onGrade: SimState = { chainage: 1_200, speed: 0, brakeActual: 1, time: 0 };
    for (const emergency of [false, true]) {
      const end = drive(
        onGrade,
        { notch: 0, brake: 1, dir: 1, emergency, mu: ADHESION.wetNight },
        10,
        EMU_GTO_4CAR,
        WESTFORD_EASTBANK,
      );
      expect(Math.abs(end.speed)).toBeLessThan(1e-3);
      expect(Math.abs(end.chainage - 1_200)).toBeLessThan(1e-2);
    }
  });
});
