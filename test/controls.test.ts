import { describe, it, expect } from "vitest";
import {
  BRAKE_EMERGENCY,
  BRAKE_FULL,
  DSD_PERIOD,
  DSD_WARN_WINDOW,
  POWER_NOTCHES,
  buildHudView,
  createInitialControls,
  createInitialSafety,
  notchFraction,
  reduceControls,
  resolveInputs,
  safetyPrompt,
  tickSafety,
  type ControlIntent,
  type ControlState,
  type HudView,
  type SafetyState,
} from "../src/sim/controls";
import { createInitialAws, tickAws } from "../src/sim/aws";
import type { AwsHud } from "../src/sim/aws";
import { EMU_GTO_4CAR, ADHESION } from "../src/sim/train";
import type { Route } from "../src/sim/route";
import { WESTFORD_EASTBANK } from "../src/sim/route";
import { createInitialState, currentSpeedLimit, step, type SimInputs, type SimState } from "../src/sim/simulation";

// ── Test fixtures & local helpers ────────────────────────────────────────────

// A genuinely-level synthetic route (mirrors physics.test.ts's flatRoute) for
// the moving-stop oracles O9/O12 — no gradient anywhere to confound the no-roll
// assertions, no stations.
const flatRoute: Route = {
  length: 100_000,
  stations: [],
  grades: [{ from: 0, to: 100_000, value: 0 }],
  speedLimits: [{ from: 0, to: 100_000, value: 40 }],
  curvatures: [{ from: 0, to: 100_000, value: 0 }],
  signals: [],
};

const MU = ADHESION.wetNight;

/** Every edge false — the base intent; spread-override the ones a test wants. */
function noIntent(): ControlIntent {
  return {
    powerUp: false,
    powerDown: false,
    brakeUp: false,
    brakeDown: false,
    emergency: false,
    reverserFwd: false,
    reverserOff: false,
    reverserRev: false,
    toggleDra: false,
    acknowledge: false,
    vigilancePing: false,
  };
}

function intent(over: Partial<ControlIntent>): ControlIntent {
  return { ...noIntent(), ...over };
}

function controls(over: Partial<ControlState> = {}): ControlState {
  return { ...createInitialControls(), ...over };
}

function stateAt(speed: number, chainage = 0): SimState {
  return { chainage, speed, brakeActual: 1, time: 0 };
}

const NO_PENALTY: SafetyState = createInitialSafety();
const PENALTY: SafetyState = {
  vigilanceTimer: 0,
  dsdWarning: true,
  penaltyReasons: new Set(["DSD"]),
};

// The neutral AwsHud the O14 fixtures assert against (no signals ⇒ BLACK/clear).
const BLACK_HUD: AwsHud = { sunflower: "BLACK", spad: false };

/**
 * Advance tickSafety over `seconds` in fine `dt` slices with fixed inputs,
 * threading an `AwsState` alongside. These DSD fixtures use signal-free routes
 * and pass `state.chainage` as both prev and now, so `tickAws` crosses nothing
 * and returns `reasons: []` every tick (DSD behaviour unchanged).
 */
function tickFor(
  s: SafetyState,
  it_: ControlIntent,
  state: SimState,
  seconds: number,
  dt = 1 / 60,
  route: Route = flatRoute,
  dir: 1 | -1 = 1,
): SafetyState {
  let cur = s;
  let a = createInitialAws();
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const o = tickAws(a, state, route, it_, state.chainage, dir, dt);
    a = o.next;
    cur = tickSafety(cur, it_, state, dt, { reasons: o.reasons });
  }
  return cur;
}

/** Drive step(...) for `seconds` with fixed SimInputs (control-layer analogue). */
function drive(
  state: SimState,
  inputs: SimInputs,
  seconds: number,
  route: Route = flatRoute,
  dt = 1 / 60,
): SimState {
  let s = state;
  for (let t = 0; t < seconds; t += dt) s = step(EMU_GTO_4CAR, route, s, inputs, dt);
  return s;
}

// ── O3 / O15 / O5 / O4 — resolveInputs interlock pipeline ────────────────────

describe("oracle O3: no power against any applied brake", () => {
  it("any applied brake ⇒ notch 0; brakeStep 0 ⇒ notch 1", () => {
    for (const brakeStep of [1, 2, 3, BRAKE_EMERGENCY]) {
      const c = controls({ powerNotch: POWER_NOTCHES, reverser: "FWD", brakeStep });
      expect(resolveInputs(c, NO_PENALTY, MU).notch).toBe(0);
    }
    const open = controls({ powerNotch: POWER_NOTCHES, reverser: "FWD", brakeStep: 0 });
    expect(resolveInputs(open, NO_PENALTY, MU).notch).toBe(1);
  });

  it("from spawn (FULL SERVICE brake) the train does not creep over 10 s flat", () => {
    const c = createInitialControls();
    const inputs = resolveInputs(c, NO_PENALTY, MU);
    const end = drive(createInitialState(0), inputs, 10);
    expect(Math.abs(end.speed)).toBeLessThan(1e-6);
    expect(Math.abs(end.chainage)).toBeLessThan(1e-6);
  });
});

describe("oracle O4: reverser OFF inhibits power", () => {
  it("notch 0 and dir tracks lastDir (never 0)", () => {
    const c = controls({ reverser: "OFF", powerNotch: 4, brakeStep: 0, lastDir: 1 });
    const out = resolveInputs(c, NO_PENALTY, MU);
    expect(out.notch).toBe(0);
    expect(out.dir).toBe(1);

    const cRev = controls({ reverser: "OFF", powerNotch: 4, brakeStep: 0, lastDir: -1 });
    expect(resolveInputs(cRev, NO_PENALTY, MU).dir).toBe(-1);
  });
});

describe("oracle O5: exact resolved fractions", () => {
  it("powerNotch 2 ⇒ notch 0.5", () => {
    const c = controls({ reverser: "FWD", brakeStep: 0, powerNotch: 2 });
    expect(resolveInputs(c, NO_PENALTY, MU).notch).toBe(0.5);
  });

  it("brakeStep 2 ⇒ brake 2/3", () => {
    const c = controls({ reverser: "FWD", powerNotch: 0, brakeStep: 2 });
    expect(resolveInputs(c, NO_PENALTY, MU).brake).toBeCloseTo(2 / 3, 12);
  });

  it("EMERGENCY ⇒ brake 1 and emergency true", () => {
    const c = controls({ reverser: "FWD", powerNotch: 0, brakeStep: BRAKE_EMERGENCY });
    const out = resolveInputs(c, NO_PENALTY, MU);
    expect(out.brake).toBe(1);
    expect(out.emergency).toBe(true);
  });
});

describe("oracle O15a-e: each power-inhibitor isolated", () => {
  // All-clear baseline: FWD, no brake, no DRA, no penalty, full power.
  const base = controls({ reverser: "FWD", brakeStep: 0, dra: false, powerNotch: POWER_NOTCHES });

  it("O15a brake-only inhibits", () => {
    expect(resolveInputs({ ...base, brakeStep: 1 }, NO_PENALTY, MU).notch).toBe(0);
  });
  it("O15b reverser-OFF-only inhibits", () => {
    expect(resolveInputs({ ...base, reverser: "OFF" }, NO_PENALTY, MU).notch).toBe(0);
  });
  it("O15c DRA-only inhibits", () => {
    expect(resolveInputs({ ...base, dra: true }, NO_PENALTY, MU).notch).toBe(0);
  });
  it("O15d penalty-only inhibits", () => {
    expect(resolveInputs(base, PENALTY, MU).notch).toBe(0);
  });
  it("O15e all-clear passes power", () => {
    const out = resolveInputs(base, NO_PENALTY, MU);
    expect(out.notch).toBe(notchFraction(POWER_NOTCHES));
    expect(out.notch).toBe(1);
  });
});

// ── O6 / O16 / O7 — reverser & DRA interlocks (reduceControls) ───────────────

describe("oracle O6: reverser only at a stand; rejected edge keeps lastDir", () => {
  it("rejected while moving (state + lastDir unchanged), accepted at a stand", () => {
    const c = controls({ reverser: "FWD", powerNotch: 0, lastDir: 1 });
    const moving = reduceControls(c, intent({ reverserRev: true }), stateAt(5), NO_PENALTY);
    expect(moving.reverser).toBe("FWD");
    expect(moving.lastDir).toBe(1);

    const stopped = reduceControls(c, intent({ reverserRev: true }), stateAt(0), NO_PENALTY);
    expect(stopped.reverser).toBe("REV");
    expect(stopped.lastDir).toBe(-1);
  });

  it("a rejected reverser edge never rewrites lastDir (behavioural invariant)", () => {
    const c = controls({ reverser: "REV", powerNotch: 0, lastDir: -1 });
    const out = reduceControls(c, intent({ reverserFwd: true }), stateAt(5), NO_PENALTY);
    expect(out.lastDir).toBe(-1);
  });

  it("composes through step: FWD ⇒ +chainage, REV ⇒ -chainage", () => {
    const fwd = controls({ reverser: "FWD", powerNotch: 4, brakeStep: 0, lastDir: 1 });
    const rev = controls({ reverser: "REV", powerNotch: 4, brakeStep: 0, lastDir: -1 });
    const fEnd = drive({ chainage: 1_000, speed: 0, brakeActual: 0, time: 0 }, resolveInputs(fwd, NO_PENALTY, ADHESION.dry), 10);
    const rEnd = drive({ chainage: 1_000, speed: 0, brakeActual: 0, time: 0 }, resolveInputs(rev, NO_PENALTY, ADHESION.dry), 10);
    expect(fEnd.chainage).toBeGreaterThan(1_000);
    expect(fEnd.speed).toBeGreaterThan(0);
    expect(rEnd.chainage).toBeLessThan(1_000);
    expect(rEnd.speed).toBeLessThan(0);
  });
});

describe("oracle O16: reverser change needs powerNotch 0 AND at a stand", () => {
  it("rejected at a stand under power; accepted at a stand with power off", () => {
    const underPower = controls({ reverser: "FWD", powerNotch: 2, lastDir: 1 });
    const rej = reduceControls(underPower, intent({ reverserRev: true }), stateAt(0), NO_PENALTY);
    expect(rej.reverser).toBe("FWD");
    expect(rej.lastDir).toBe(1);

    const off = controls({ reverser: "FWD", powerNotch: 0, lastDir: 1 });
    const acc = reduceControls(off, intent({ reverserRev: true }), stateAt(0), NO_PENALTY);
    expect(acc.reverser).toBe("REV");
    expect(acc.lastDir).toBe(-1);
  });
});

describe("oracle O7: DRA inhibits power; cancel-at-stand restores", () => {
  it("DRA set ⇒ notch 0; toggle off at a stand ⇒ notch 1; toggle while moving rejected", () => {
    const draOn = controls({ dra: true, reverser: "FWD", powerNotch: 4, brakeStep: 0 });
    expect(resolveInputs(draOn, NO_PENALTY, MU).notch).toBe(0);

    const cancelled = reduceControls(draOn, intent({ toggleDra: true }), stateAt(0), NO_PENALTY);
    expect(cancelled.dra).toBe(false);
    expect(resolveInputs(cancelled, NO_PENALTY, MU).notch).toBe(1);

    const moving = reduceControls(draOn, intent({ toggleDra: true }), stateAt(5), NO_PENALTY);
    expect(moving.dra).toBe(true);
  });
});

// ── O17 / O19 — brake stepping & EMERGENCY latch (reduceControls) ────────────

describe("oracle O17: stepped brake with an end gate", () => {
  it("brakeUp from {0,1,2} never reaches EMERGENCY", () => {
    for (const brakeStep of [0, 1, 2]) {
      const out = reduceControls(controls({ brakeStep }), intent({ brakeUp: true }), stateAt(0), NO_PENALTY);
      expect(out.brakeStep).toBe(brakeStep + 1);
      expect(out.brakeStep).not.toBe(BRAKE_EMERGENCY);
    }
  });

  it("brakeUp from FULL(3) reaches EMERGENCY(4)", () => {
    const out = reduceControls(controls({ brakeStep: BRAKE_FULL }), intent({ brakeUp: true }), stateAt(0), NO_PENALTY);
    expect(out.brakeStep).toBe(BRAKE_EMERGENCY);
  });

  it("brakeDown decrements one step and clamps at 0", () => {
    const out = reduceControls(controls({ brakeStep: 2 }), intent({ brakeDown: true }), stateAt(0), NO_PENALTY);
    expect(out.brakeStep).toBe(1);
    const floor = reduceControls(controls({ brakeStep: 0 }), intent({ brakeDown: true }), stateAt(0), NO_PENALTY);
    expect(floor.brakeStep).toBe(0);
  });

  it("the emergency edge slams to EMERGENCY from any step", () => {
    for (const brakeStep of [0, 1, 2, 3]) {
      const out = reduceControls(controls({ brakeStep }), intent({ emergency: true }), stateAt(20), NO_PENALTY);
      expect(out.brakeStep).toBe(BRAKE_EMERGENCY);
    }
  });
});

describe("oracle O19: EMERGENCY latches — release only at a stand", () => {
  it("brakeDown rejected while moving, accepted (→FULL) at a stand", () => {
    const c = controls({ brakeStep: BRAKE_EMERGENCY });
    const moving = reduceControls(c, intent({ brakeDown: true }), stateAt(10), NO_PENALTY);
    expect(moving.brakeStep).toBe(BRAKE_EMERGENCY);

    const stopped = reduceControls(c, intent({ brakeDown: true }), stateAt(0), NO_PENALTY);
    expect(stopped.brakeStep).toBe(BRAKE_FULL);
  });
});

// ── O20 — simultaneous conflicting edges (reduceControls) ────────────────────

describe("oracle O20: one-frame conflict resolution", () => {
  it("opposing power edges cancel", () => {
    const out = reduceControls(controls({ powerNotch: 2 }), intent({ powerUp: true, powerDown: true }), stateAt(0), NO_PENALTY);
    expect(out.powerNotch).toBe(2);
  });
  it("opposing brake edges cancel", () => {
    const out = reduceControls(controls({ brakeStep: 1 }), intent({ brakeUp: true, brakeDown: true }), stateAt(0), NO_PENALTY);
    expect(out.brakeStep).toBe(1);
  });
  it("emergency overrides a brakeDown ⇒ EMERGENCY wins, brakeDown suppressed", () => {
    // brakeDown ALONE from STEP 1 would step down to RELEASE(0)…
    const down = reduceControls(controls({ brakeStep: 1 }), intent({ brakeDown: true }), stateAt(20), NO_PENALTY);
    expect(down.brakeStep).toBe(0);
    // …but with emergency set, resolveEdges suppresses the brakeDown and the
    // emergency wins outright — a result distinct from brakeDown alone.
    const out = reduceControls(controls({ brakeStep: 1 }), intent({ emergency: true, brakeDown: true }), stateAt(20), NO_PENALTY);
    expect(out.brakeStep).toBe(BRAKE_EMERGENCY);
    expect(out.brakeStep).not.toBe(down.brakeStep);
  });
  it("multiple reverser edges are all ignored", () => {
    const c = controls({ reverser: "FWD", powerNotch: 0, lastDir: 1 });
    const out = reduceControls(c, intent({ reverserFwd: true, reverserRev: true }), stateAt(0), NO_PENALTY);
    expect(out.reverser).toBe("FWD");
    expect(out.lastDir).toBe(1);
  });
});

// ── O22 — power handle returns to OFF after a penalty (reduceControls) ───────

describe("oracle O22: power handle returns to OFF after a penalty", () => {
  it("(a) a latched penalty forces powerNotch 0", () => {
    const c = controls({ powerNotch: 4 });
    const out = reduceControls(c, noIntent(), stateAt(0), PENALTY);
    expect(out.powerNotch).toBe(0);
  });

  it("(b) no instant restore on release; only a fresh powerUp after release advances", () => {
    // Latched: a powerUp while the penalty is active is overridden back to 0.
    const latched = reduceControls(controls({ powerNotch: 0 }), intent({ powerUp: true }), stateAt(0), PENALTY);
    expect(latched.powerNotch).toBe(0);

    // Released, no powerUp ⇒ stays 0 (no restore of the pre-penalty notch).
    const idle = reduceControls(controls({ powerNotch: 0 }), noIntent(), stateAt(0), NO_PENALTY);
    expect(idle.powerNotch).toBe(0);

    // Released, fresh powerUp ⇒ advances to 1.
    const resumed = reduceControls(controls({ powerNotch: 0 }), intent({ powerUp: true }), stateAt(0), NO_PENALTY);
    expect(resumed.powerNotch).toBe(1);
  });
});

// ── O8a / O8b — DSD frame-rate independence & crossing (tickSafety) ──────────

describe("oracle O8a: frame-rate independence (end-state equality)", () => {
  it("coarse-dt and fine-dt over equal elapsed time yield equal SafetyState", () => {
    const elapsed = DSD_PERIOD + 5; // crosses both warn and penalty thresholds
    const moving = stateAt(20);
    const ping = noIntent(); // no vigilancePing

    const coarse = tickFor(createInitialSafety(), ping, moving, elapsed, elapsed); // one big step
    const fine = tickFor(createInitialSafety(), ping, moving, elapsed, 0.1);

    expect(coarse.vigilanceTimer).toBeCloseTo(fine.vigilanceTimer, 6);
    expect(coarse.dsdWarning).toBe(fine.dsdWarning);
    expect([...coarse.penaltyReasons].sort()).toEqual([...fine.penaltyReasons].sort());
    expect(fine.penaltyReasons.has("DSD")).toBe(true);
  });
});

describe("oracle O8b: warn→penalty crossing (fine-dt only)", () => {
  it("dsdWarning flips at the warn window (latch still empty), then DSD latches", () => {
    const moving = stateAt(20);
    const ping = noIntent();
    const dt = 0.1;
    let s = createInitialSafety();

    // Advance to just past the warn crossing.
    s = tickFor(s, ping, moving, DSD_PERIOD - DSD_WARN_WINDOW + 1, dt);
    expect(s.dsdWarning).toBe(true);
    expect(s.penaltyReasons.size).toBe(0);

    // Advance past the penalty threshold.
    s = tickFor(s, ping, moving, DSD_WARN_WINDOW + 1, dt);
    expect(s.penaltyReasons.has("DSD")).toBe(true);
  });
});

// ── O9 / O10 / O11 / O12 / O18 / O23 — DSD penalty latch behaviour ───────────

describe("oracle O9: timeout → penalty → stop (moving, flatRoute)", () => {
  it("moving with no ping for DSD_PERIOD latches DSD; parked never does", () => {
    const moving = stateAt(20);
    const sMoving = tickFor(createInitialSafety(), noIntent(), moving, DSD_PERIOD + 1);
    expect(sMoving.dsdWarning).toBe(true);
    expect(sMoving.penaltyReasons.has("DSD")).toBe(true);

    // Parked companion: timer holds, never latches.
    const parked = stateAt(0);
    const sParked = tickFor(createInitialSafety(), noIntent(), parked, DSD_PERIOD + 1);
    expect(sParked.penaltyReasons.size).toBe(0);
    expect(sParked.vigilanceTimer).toBe(DSD_PERIOD);

    // Penalty forces brake=1, emergency=false, notch=0 ⇒ stops. Build from a
    // RELEASE lever (brakeStep 0) so the full demand can ONLY come from the
    // penalty latch, not a coincidentally-full lever.
    const releaseLever = controls({ brakeStep: 0 });
    const inputs = resolveInputs(releaseLever, sMoving, MU);
    expect(inputs.brake).toBe(1);
    expect(inputs.emergency).toBe(false);
    expect(inputs.notch).toBe(0);
    const end = drive({ chainage: 0, speed: 20, brakeActual: 0, time: 0 }, inputs, 40);
    expect(Math.abs(end.speed)).toBeLessThan(0.05);
  });
});

describe("oracle O10: ack at a stand releases the latch", () => {
  it("acknowledge while stopped empties penaltyReasons; power available again", () => {
    const released = tickSafety(PENALTY, intent({ acknowledge: true, vigilancePing: true }), stateAt(0), 1 / 60, tickAws(createInitialAws(), stateAt(0), flatRoute, intent({ acknowledge: true, vigilancePing: true }), 0, 1, 1 / 60));
    expect(released.penaltyReasons.size).toBe(0);

    const c = controls({ reverser: "FWD", powerNotch: 4, brakeStep: 0 });
    expect(resolveInputs(c, released, MU).notch).toBe(1);
  });
});

describe("oracle O11: ack while moving does NOT release", () => {
  it("acknowledge at speed 5 keeps DSD latched", () => {
    const out = tickSafety(PENALTY, intent({ acknowledge: true, vigilancePing: true }), stateAt(5), 1 / 60, tickAws(createInitialAws(), stateAt(5), flatRoute, intent({ acknowledge: true, vigilancePing: true }), 0, 1, 1 / 60));
    expect(out.penaltyReasons.has("DSD")).toBe(true);
  });
});

describe("oracle O10b: at a stand WITHOUT ack does NOT release (ack-edge half)", () => {
  it("ticking a latched penalty at a stand with no acknowledge keeps DSD", () => {
    // Pins the acknowledge-EDGE half of the release predicate: standing still is
    // necessary but NOT sufficient — release also requires the ack intent.
    const held = tickFor(PENALTY, noIntent(), stateAt(0), 1, 1 / 60);
    expect(held.penaltyReasons.has("DSD")).toBe(true);
  });
});

describe("oracle O12: penalty brake is full SERVICE, not emergency (flatRoute)", () => {
  it("emergency false, brake 1; stops cleanly on the level", () => {
    // RELEASE lever (brakeStep 0): the full demand must originate from the
    // penalty latch alone, so dropping the penalty term would fail this oracle.
    const inputs = resolveInputs(controls({ brakeStep: 0 }), PENALTY, MU);
    expect(inputs.emergency).toBe(false);
    expect(inputs.brake).toBe(1);
    const end = drive({ chainage: 0, speed: 20, brakeActual: 0, time: 0 }, inputs, 40);
    expect(Math.abs(end.speed)).toBeLessThan(0.05);
  });
});

describe("oracle O18: periodic pings while moving never penalise", () => {
  it("pinging every 50 s (< 53 s) over 2×DSD_PERIOD keeps warning off and latch empty", () => {
    const moving = stateAt(20);
    const dt = 0.5;
    const pingInterval = 50; // < DSD_PERIOD - DSD_WARN_WINDOW = 53
    let s = createInitialSafety();
    let sinceLastPing = 0;
    for (let t = 0; t < 2 * DSD_PERIOD; t += dt) {
      const ping = sinceLastPing >= pingInterval;
      const pingIntent = ping ? intent({ vigilancePing: true }) : noIntent();
      s = tickSafety(s, pingIntent, moving, dt, tickAws(createInitialAws(), moving, flatRoute, pingIntent, moving.chainage, 1, dt));
      sinceLastPing = ping ? 0 : sinceLastPing + dt;
      expect(s.dsdWarning).toBe(false);
      expect(s.penaltyReasons.size).toBe(0);
    }
  });
});

describe("oracle O23: penalty brake holds on a real falling grade", () => {
  it("full-service penalty holds at chainage 5200 on WESTFORD_EASTBANK (wet night)", () => {
    // RELEASE lever (brakeStep 0): the holding demand comes from the penalty
    // latch alone, not a coincidentally-full lever.
    const inputs = resolveInputs(controls({ brakeStep: 0 }), PENALTY, ADHESION.wetNight);
    expect(inputs.emergency).toBe(false);
    expect(inputs.brake).toBe(1);
    expect(inputs.notch).toBe(0);
    const start: SimState = { chainage: 5_200, speed: 0, brakeActual: 1, time: 0 };
    const end = drive(start, inputs, 30, WESTFORD_EASTBANK);
    expect(Math.abs(end.speed)).toBeLessThan(0.05);
    expect(Math.abs(end.chainage - 5_200)).toBeLessThan(1);
  });
});

// ── H2 — O13 migration: signal-free DSD invariant preserved ──────────────────

describe("oracle H2: signal-free route ⇒ DSD unchanged; DSD-scoped seed releases", () => {
  it("DSD latches alone, pings stay clear, and ack-at-stand still releases DSD", () => {
    // A full tickFor over DSD_PERIOD on the signal-free route adds DSD only —
    // tickAws crosses nothing (no signals) and returns []. (Original O13 body.)
    const moving = stateAt(20);
    const s = tickFor(createInitialSafety(), noIntent(), moving, DSD_PERIOD + 1);
    expect([...s.penaltyReasons]).toEqual(["DSD"]);

    // Vigilance pings keep it penalty-free.
    const pinged = tickFor(createInitialSafety(), intent({ vigilancePing: true }), moving, DSD_PERIOD + 1);
    expect(pinged.penaltyReasons.size).toBe(0);

    // The DSD-scoped seed does not regress DSD release: ack-at-stand clears it.
    const ack = intent({ acknowledge: true, vigilancePing: true });
    const released = tickSafety(
      s,
      ack,
      stateAt(0),
      1 / 60,
      tickAws(createInitialAws(), stateAt(0), flatRoute, ack, 0, 1, 1 / 60),
    );
    expect(released.penaltyReasons.size).toBe(0);
  });
});

// ── O14 — buildHudView projection (pure) ─────────────────────────────────────

describe("oracle O14: buildHudView projection", () => {
  const MPS_TO_MPH = 2.236936;

  it("speed/limit/chainage/labels/lamps and demand-vs-actual lag", () => {
    const c = controls({ reverser: "FWD", powerNotch: 2, brakeStep: 2, dra: true });
    const state: SimState = { chainage: 0, speed: 10, brakeActual: 0.4, time: 0 };
    const safety: SafetyState = { vigilanceTimer: 5, dsdWarning: true, penaltyReasons: new Set() };
    const v = buildHudView(state, c, safety, WESTFORD_EASTBANK, new Set(), BLACK_HUD);

    expect(v.speedMph).toBeCloseTo(10 * MPS_TO_MPH, 9);
    expect(v.limitMph).toBeCloseTo(currentSpeedLimit(WESTFORD_EASTBANK, state) * MPS_TO_MPH, 9); // pins the HUD's currentSpeedLimit path (P7)
    expect(v.chainage).toBe(0);
    expect(v.reverser).toBe("FWD");
    expect(v.powerNotch).toBe(2);
    expect(v.powerMax).toBe(POWER_NOTCHES);
    expect(v.brakeLabel).toBe("STEP 2");
    // demand (resolved) vs actual: lever STEP 2 ⇒ 2/3; actual 0.4 ⇒ distinct.
    expect(v.brakeDemandPct).toBeCloseTo((2 / 3) * 100, 9);
    expect(v.brakeActualPct).toBeCloseTo(40, 9);
    expect(v.brakeDemandPct).not.toBeCloseTo(v.brakeActualPct, 5);
    expect(v.dra).toBe(true);
    expect(v.dsdWarning).toBe(true);
    expect(v.penalty).toBe(false);
    // Aspect/sunflower additions (D11): chainage 0 FWD, served empty ⇒ the next
    // signal ahead is S1 (Riverside RED); the BLACK_HUD ⇒ sunflower BLACK.
    expect(v.aspect).toBe("RED");
    expect(v.sunflower).toBe("BLACK");
  });

  it("aspect tracks served and sunflower copies the AwsHud", () => {
    const c = controls({ reverser: "FWD", lastDir: 1 });
    const state: SimState = { chainage: 0, speed: 0, brakeActual: 1, time: 0 };
    const allServed = new Set(["Riverside", "City Centre", "Victoria Street"]);
    // Whole line served ⇒ S1 GREEN; CAUTION sunflower flows through from the HUD.
    const v = buildHudView(state, c, createInitialSafety(), WESTFORD_EASTBANK, allServed, {
      sunflower: "CAUTION",
      spad: true,
    });
    expect(v.aspect).toBe("GREEN");
    expect(v.sunflower).toBe("CAUTION");
    // Reverse running shows decorative GREEN regardless of served.
    const rev = controls({ reverser: "REV", lastDir: -1 });
    const vRev = buildHudView(
      { chainage: 1_600, speed: 0, brakeActual: 1, time: 0 },
      rev,
      createInitialSafety(),
      WESTFORD_EASTBANK,
      new Set(),
      BLACK_HUD,
    );
    expect(vRev.aspect).toBe("GREEN");
  });

  it("at spawn both demand and actual read FULL SERVICE", () => {
    const v = buildHudView(createInitialState(0), createInitialControls(), createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.brakeLabel).toBe("FULL SERVICE");
    expect(v.brakeDemandPct).toBeCloseTo(100, 9);
    expect(v.brakeActualPct).toBeCloseTo(100, 9);
  });

  it("under penalty the displayed demand is forced full even with a lower lever", () => {
    const c = controls({ brakeStep: 1 }); // STEP 1 lever
    const v = buildHudView(createInitialState(0), c, PENALTY, WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.brakeLabel).toBe("STEP 1"); // lever label is the physical lever
    expect(v.brakeDemandPct).toBeCloseTo(100, 9); // resolved demand is forced full
    expect(v.penalty).toBe(true);
  });

  it("EMERGENCY label", () => {
    const c = controls({ brakeStep: BRAKE_EMERGENCY });
    const v = buildHudView(createInitialState(0), c, createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.brakeLabel).toBe("EMERGENCY");
  });

  it("nextStop SPAWN: chainage 0, +1 ⇒ Riverside (Westford already reached)", () => {
    const c = controls({ lastDir: 1 });
    const v = buildHudView(createInitialState(0), c, createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.nextStop).toBe("Riverside");
  });

  it("nextStop forward picks the next increasing-chainage station", () => {
    const c = controls({ lastDir: 1 });
    const v = buildHudView({ chainage: 1_600, speed: 0, brakeActual: 1, time: 0 }, c, createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.nextStop).toBe("City Centre"); // 3100 ahead of 1600
  });

  it("nextStop reverse: chainage 3200, -1 ⇒ City Centre (not Victoria Street)", () => {
    const c = controls({ lastDir: -1 });
    const v = buildHudView({ chainage: 3_200, speed: 0, brakeActual: 1, time: 0 }, c, createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.nextStop).toBe("City Centre");
  });

  it("nextStop end-of-line: chainage 0, -1 ⇒ end of line", () => {
    const c = controls({ lastDir: -1 });
    const v = buildHudView(createInitialState(0), c, createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD);
    expect(v.nextStop).toBe("— (end of line)");
  });
});

// ── safetyPrompt — the actionable on-screen instruction (AC-3) ───────────────
describe("safetyPrompt — on-screen safety instruction", () => {
  const base: HudView = buildHudView(
    createInitialState(0), controls({}), createInitialSafety(), WESTFORD_EASTBANK, new Set(), BLACK_HUD,
  );

  it("penalty ⇒ STOP-then-Q instruction (encodes the at-a-stand release)", () => {
    expect(safetyPrompt({ ...base, penalty: true })).toBe("PENALTY — STOP, THEN PRESS Q");
  });
  it("vigilance warning only ⇒ PRESS-Q instruction", () => {
    expect(safetyPrompt({ ...base, dsdWarning: true, penalty: false })).toBe("VIGILANCE — PRESS Q");
  });
  it("penalty takes precedence over the warning", () => {
    expect(safetyPrompt({ ...base, penalty: true, dsdWarning: true })).toBe("PENALTY — STOP, THEN PRESS Q");
  });
  it("neither ⇒ null (no prompt)", () => {
    expect(safetyPrompt({ ...base, penalty: false, dsdWarning: false })).toBe(null);
  });
});
