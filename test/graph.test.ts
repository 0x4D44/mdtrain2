import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import { step, type SimInputs, type SimState } from "../src/sim/simulation";
import { EMU_GTO_4CAR } from "../src/sim/train";

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
