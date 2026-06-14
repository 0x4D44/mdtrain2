// The pure controls / safety / HUD-derivation brain. No DOM, no three, no
// wall-clock: all timed safety advances off the explicit `dt` passed to
// `tickSafety` (R4 — determinism). Holds the parallel `ControlState` +
// `SafetyState` stepped alongside `step()`, and turns driver intent + timed
// safety into the existing `SimInputs`.

import type { AwsHud, AwsOutput, Sunflower } from "./aws";
import { clamp, clamp01 } from "./physics";
import type { Aspect, Route } from "./route";
import { aspectAt, nextSignalAhead } from "./route";
import { currentSpeedLimit, type SimInputs, type SimState } from "./simulation";

// ── Types ────────────────────────────────────────────────────────────────────

export type Reverser = "FWD" | "OFF" | "REV";
export type PenaltyReason = "DSD" | "AWS" | "TPWS"; // AWS/TPWS reserved for Phase 2

export interface ControlState {
  powerNotch: number; // 0..POWER_NOTCHES   (integer index; 0 = OFF)
  brakeStep: number; // 0..BRAKE_EMERGENCY (0=RELEASE,1=STEP 1,2=STEP 2,3=FULL SERVICE,4=EMERGENCY)
  reverser: Reverser;
  lastDir: 1 | -1; // remembered heading; reverser OFF keeps this; feeds SimInputs.dir; never 0
  dra: boolean; // Driver's Reminder Appliance: set ⇒ power inhibited
}

export interface SafetyState {
  vigilanceTimer: number; // s remaining before warning; counts DOWN off dt
  dsdWarning: boolean; // warning window active (amber lamp)
  penaltyReasons: ReadonlySet<PenaltyReason>; // the SHARED latch: active iff non-empty
}

/** A flat record of edges for one frame, applied by the pure reducers. */
export interface ControlIntent {
  powerUp: boolean;
  powerDown: boolean;
  brakeUp: boolean;
  brakeDown: boolean;
  emergency: boolean; // edge: slam to EMERGENCY
  reverserFwd: boolean;
  reverserOff: boolean;
  reverserRev: boolean;
  toggleDra: boolean;
  acknowledge: boolean; // edge: DSD/penalty ack
  vigilancePing: boolean; // any control activity this frame ⇒ resets DSD
}

export interface HudView {
  speedMph: number;
  limitMph: number;
  reverser: Reverser;
  powerNotch: number;
  powerMax: number;
  brakeLabel: string; // RELEASE | STEP 1 | STEP 2 | FULL SERVICE | EMERGENCY
  brakeDemandPct: number; // resolved demand (incl. penalty/emergency-forced full application)
  brakeActualPct: number; // lagged pneumatic build-up
  dra: boolean;
  dsdWarning: boolean;
  penalty: boolean;
  nextStop: string;
  chainage: number;
  aspect: Aspect; // next-signal-ahead aspect, derived (GREEN when none ahead / reverse)
  sunflower: Sunflower; // AWS caution reminder lamp
}

// ── Constants ────────────────────────────────────────────────────────────────

export const POWER_NOTCHES = 4; // OFF + 4 detents
export const BRAKE_SERVICE_STEPS = 3; // service steps 1..3
export const BRAKE_FULL = BRAKE_SERVICE_STEPS; // index 3 = FULL SERVICE
export const BRAKE_EMERGENCY = BRAKE_SERVICE_STEPS + 1; // index 4 = EMERGENCY (past the end gate)
export const STAND_EPS = 0.3; // m/s — "at a stand" (reverser, DRA, latch release)
export const DSD_PERIOD = 60; // s vigilance interval
export const DSD_WARN_WINDOW = 7; // s of warning before penalty

const MPS_TO_MPH = 2.236936;

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function notchFraction(powerNotch: number): number {
  return clamp(powerNotch, 0, POWER_NOTCHES) / POWER_NOTCHES;
}

/** Service brake fraction: clamp01(step/3) ⇒ {0,⅓,⅔,1}; FULL→1, EMERGENCY→1. */
export function brakeFraction(brakeStep: number): number {
  return clamp01(brakeStep / BRAKE_SERVICE_STEPS);
}

export function isEmergency(brakeStep: number): boolean {
  return brakeStep >= BRAKE_EMERGENCY;
}

export function brakeApplied(brakeStep: number): boolean {
  return brakeStep > 0;
}

export function penaltyActive(s: SafetyState): boolean {
  return s.penaltyReasons.size > 0;
}

function atStand(state: SimState): boolean {
  return Math.abs(state.speed) <= STAND_EPS;
}

/**
 * Resolved brake demand: the larger of the driver's lever fraction and the
 * penalty's full-service application. Shared by `resolveInputs` (the physics
 * seam) and `buildHudView` (the display) so neither duplicates the rule.
 */
export function resolvedBrakeDemand(c: ControlState, s: SafetyState): number {
  return Math.max(brakeFraction(c.brakeStep), penaltyActive(s) ? 1 : 0);
}

// ── Initial state ────────────────────────────────────────────────────────────

export function createInitialControls(): ControlState {
  // FULL SERVICE at spawn ⇒ matches brakeActual=1 (R5): lever, demand, and
  // actual all agree, so there is no released-lever-vs-applied-brake mismatch.
  return { powerNotch: 0, brakeStep: BRAKE_FULL, reverser: "OFF", lastDir: 1, dra: false };
}

export function createInitialSafety(): SafetyState {
  return { vigilanceTimer: DSD_PERIOD, dsdWarning: false, penaltyReasons: new Set() };
}

// ── Control reduction (pure) ─────────────────────────────────────────────────

/**
 * Resolve one frame's edges into a well-defined, order-independent set:
 *   - `emergency` overrides all other brake edges (it wins outright);
 *   - opposing `brakeUp`+`brakeDown` cancel (no brake change);
 *   - opposing `powerUp`+`powerDown` cancel (no power change);
 *   - more than one reverser edge in a frame ⇒ all ignored (no reverser change).
 */
interface ResolvedEdges {
  powerUp: boolean;
  powerDown: boolean;
  brakeUp: boolean;
  brakeDown: boolean;
  emergency: boolean;
  reverser: Reverser | null; // the single accepted reverser edge, or null
}

function resolveEdges(intent: ControlIntent): ResolvedEdges {
  const reverserCount =
    (intent.reverserFwd ? 1 : 0) + (intent.reverserOff ? 1 : 0) + (intent.reverserRev ? 1 : 0);
  const reverser: Reverser | null =
    reverserCount === 1
      ? intent.reverserFwd
        ? "FWD"
        : intent.reverserOff
          ? "OFF"
          : "REV"
      : null;

  const emergency = intent.emergency;
  // emergency overrides brake edges; opposing brake edges cancel.
  const brakeUp = emergency ? false : intent.brakeUp && !intent.brakeDown;
  const brakeDown = emergency ? false : intent.brakeDown && !intent.brakeUp;
  // opposing power edges cancel.
  const powerUp = intent.powerUp && !intent.powerDown;
  const powerDown = intent.powerDown && !intent.powerUp;

  return { powerUp, powerDown, brakeUp, brakeDown, emergency, reverser };
}

/**
 * Apply driver intent to the control state (pure; mutates nothing). Reads the
 * one-frame-stale `safety` for the power-to-OFF-under-penalty interlock (D23).
 */
export function reduceControls(
  c: ControlState,
  intent: ControlIntent,
  state: SimState,
  safety: SafetyState,
): ControlState {
  const e = resolveEdges(intent);
  const stand = atStand(state);

  let { powerNotch, brakeStep, reverser, lastDir, dra } = c;

  // 1. Reverser — accepted only if powerNotch === 0 AND at a stand.
  if (e.reverser !== null && powerNotch === 0 && stand) {
    reverser = e.reverser;
    if (e.reverser === "FWD") lastDir = 1;
    else if (e.reverser === "REV") lastDir = -1;
    // OFF keeps lastDir.
  }

  // 2. Power — step ±1 clamped, then force OFF while a penalty is active.
  if (e.powerUp) powerNotch = clamp(powerNotch + 1, 0, POWER_NOTCHES);
  if (e.powerDown) powerNotch = clamp(powerNotch - 1, 0, POWER_NOTCHES);
  if (penaltyActive(safety)) powerNotch = 0; // power handle driven back to OFF (no lurch on release)

  // 3. Brake — stepped 0→1→2→3(FULL)→4(EMERGENCY) with the EMERGENCY latch.
  if (e.emergency) {
    brakeStep = BRAKE_EMERGENCY; // edge slams straight to EMERGENCY
  } else if (e.brakeUp) {
    brakeStep = clamp(brakeStep + 1, 0, BRAKE_EMERGENCY);
  } else if (e.brakeDown) {
    // EMERGENCY(4)→FULL(3) only at a stand; service steps decrement freely.
    if (brakeStep === BRAKE_EMERGENCY && !stand) {
      // rejected — emergency latches while moving
    } else {
      brakeStep = clamp(brakeStep - 1, 0, BRAKE_EMERGENCY);
    }
  }

  // 4. DRA toggle — only at a stand.
  if (intent.toggleDra && stand) dra = !dra;

  return { powerNotch, brakeStep, reverser, lastDir, dra };
}

// ── resolveInputs — the interlock pipeline (PRIMARY SEAM) ────────────────────

/**
 * Turn control + safety state into `SimInputs`. Fixed composition order;
 * power-inhibitors OR-compose, brake-demands `max`-compose. Order-independent
 * by construction.
 */
export function resolveInputs(c: ControlState, s: SafetyState, mu: number): SimInputs {
  const dir = c.lastDir;
  const penaltyOn = penaltyActive(s);
  const powerInhibit =
    brakeApplied(c.brakeStep) || c.reverser === "OFF" || c.dra || penaltyOn;
  const notch = powerInhibit ? 0 : notchFraction(c.powerNotch);
  const emergency = isEmergency(c.brakeStep); // ONLY the driver's EMERGENCY lever
  const brake = resolvedBrakeDemand(c, s); // max(lever, penalty full-service)
  return { notch, brake, dir, emergency, mu };
}

// ── DSD / vigilance / shared penalty latch (pure) ────────────────────────────

/**
 * Advance the timed safety state by `dt` (returns a new state; advances only
 * off `dt` — R4).
 *
 * The shared penalty latch is a `Set<PenaltyReason>`, active iff non-empty.
 * Each subsystem adds/removes only its own reason.
 *
 * RELEASE CONTRACT (do not break this when wiring AWS/TPWS in Phase 2):
 *   A reason is removed from `penaltyReasons` on an `acknowledge` edge AND
 *   `|state.speed| ≤ STAND_EPS`. The overall latch is "released" only when the
 *   set becomes empty — that empty-set rule is the mandated invariant. In
 *   Phase 1 the only reason is "DSD": acking at a stand clears it.
 *
 *   Forward-looking (Phase 2): a reason whose source still demands brake after
 *   ack (e.g. an AWS magnet just passed) should additionally fail a "source no
 *   longer demands it" predicate and stay in the set — slotting in WITHOUT
 *   touching this release machine. Phase 1 implements no such persisting reason.
 */
export function tickSafety(
  s: SafetyState,
  intent: ControlIntent,
  state: SimState,
  dt: number,
  aws: AwsOutput,
): SafetyState {
  let vigilanceTimer = s.vigilanceTimer;
  let dsdWarning = s.dsdWarning;
  // P2-RA: carry-forward seed scoped to DSD-only. AWS/TPWS reasons are re-derived
  // fresh from the fold (:275) every tick (present iff `tickAws` returns them),
  // so they become releasable the same tick the source stops demanding them.
  const reasons = new Set<PenaltyReason>();
  if (s.penaltyReasons.has("DSD")) reasons.add("DSD");

  const stand = atStand(state);

  // 1. Vigilance reset on any control edge (acknowledge included).
  if (intent.vigilancePing) {
    vigilanceTimer = DSD_PERIOD;
    dsdWarning = false;
  } else if (!stand) {
    // 2. Countdown (motion-gated). At a stand (no ping) the timer and warning
    //    simply hold — they keep the seeded values above, no branch needed.
    vigilanceTimer -= dt;
    dsdWarning = vigilanceTimer <= DSD_WARN_WINDOW;
    if (vigilanceTimer <= 0) reasons.add("DSD");
  }

  // 3. AWS/TPWS merge at the same point DSD adds its reason (Phase 1: none).
  for (const r of aws.reasons) reasons.add(r);

  // 4. Latch release: ack edge AND at a stand clears clearable reasons.
  if (intent.acknowledge && stand) {
    reasons.delete("DSD");
    // (Phase-2 persisting reasons would re-add themselves above; none here.)
  }

  return { vigilanceTimer, dsdWarning, penaltyReasons: reasons };
}

// ── HUD projection (pure) ────────────────────────────────────────────────────

const BRAKE_RELEASE = 0; // index 0 = RELEASE (lever fully off)

function brakeLabel(brakeStep: number): string {
  if (brakeStep <= BRAKE_RELEASE) return "RELEASE";
  if (brakeStep >= BRAKE_EMERGENCY) return "EMERGENCY"; // (and any overshoot)
  if (brakeStep >= BRAKE_FULL) return "FULL SERVICE";
  return `STEP ${brakeStep}`; // service steps between RELEASE and FULL
}

/**
 * Pure projection of state + control + safety into the HUD's view model.
 * `nextStop` is the first station STRICTLY ahead of `chainage` in `lastDir`
 * (a station at the exact current chainage counts as already reached).
 */
export function buildHudView(
  state: SimState,
  c: ControlState,
  s: SafetyState,
  route: Route,
  served: ReadonlySet<string>,
  aws: AwsHud,
): HudView {
  const penalty = penaltyActive(s);

  // Next station strictly ahead in lastDir; guard the lookup (noUncheckedIndexedAccess).
  let nextStop = "— (end of line)";
  let bestAhead = Infinity;
  for (const station of route.stations) {
    const ahead = (station.chainage - state.chainage) * c.lastDir;
    if (ahead > 0 && ahead < bestAhead) {
      bestAhead = ahead;
      nextStop = station.name;
    }
  }

  // HUD aspect: the next signal ahead in lastDir over `served`; GREEN when none
  // ahead (which includes reverse running, where nextSignalAhead returns null).
  const ahead = nextSignalAhead(route, state.chainage, c.lastDir);
  const aspect: Aspect = ahead ? aspectAt(route, ahead.i, served) : "GREEN";

  return {
    speedMph: Math.abs(state.speed) * MPS_TO_MPH,
    limitMph: currentSpeedLimit(route, state) * MPS_TO_MPH,
    reverser: c.reverser,
    powerNotch: c.powerNotch,
    powerMax: POWER_NOTCHES,
    brakeLabel: brakeLabel(c.brakeStep),
    brakeDemandPct: resolvedBrakeDemand(c, s) * 100,
    brakeActualPct: state.brakeActual * 100,
    dra: c.dra,
    dsdWarning: s.dsdWarning,
    penalty,
    nextStop,
    chainage: state.chainage,
    aspect,
    sunflower: aws.sunflower,
  };
}
