// AWS / TPWS / SPAD machine (Phase 2). Pure and dt-counted: no wall-clock or
// nondeterministic sources — every countdown advances off the explicit `dt`,
// every crossing off swept intervals. The single growth site for the warning
// lifecycle + the one BRAKE latch (AWS + TSS + OSS) + SPAD. Only a
// `PenaltyReason[]` crosses the latch boundary (`AwsOutput`); `SafetyState`
// absorbs no AWS internals.

import type { ControlIntent, PenaltyReason } from "./controls";
import { STAND_EPS } from "./controls";
import type { Route } from "./route";
import {
  AWS_MAGNET_OFFSET,
  OSS_LOOP_OFFSET,
  aspectAt,
  pointsCrossedFwd,
} from "./route";
import type { SimState } from "./simulation";

// ── Types ────────────────────────────────────────────────────────────────────

/** Warning lifecycle only; "braked" is derived from `brakeReason !== null` (F6). */
export type AwsPhase = "CLEAR" | "WARNING";
/** all-black = clear; black/yellow = caution-latched. */
export type Sunflower = "BLACK" | "CAUTION";

export interface AwsState {
  phase: AwsPhase; // AWS warning lifecycle: CLEAR | WARNING
  warnTimer: number; // s remaining in the ack window; counts DOWN off dt (WARNING only)
  sunflower: Sunflower; // latched caution reminder; reset to BLACK on serving a station
  brakeReason: PenaltyReason | null; // single BRAKE-latch source: "AWS" | "TPWS" | null
  //   braked ⟺ brakeReason !== null (F6: the one source of "braked")
  served: ReadonlySet<string>; // stations whose booked stop is done (occupancy proxy)
  spad: boolean; // sticky SPAD event flag (HUD/scoring)
}

export interface AwsHud {
  sunflower: Sunflower;
  spad: boolean;
} // NO aspect field here

export interface AwsOutput {
  reasons: PenaltyReason[];
} // UNCHANGED latch-boundary type

// ── Constants (D9 — all pinned) ──────────────────────────────────────────────

// STARTER_OFFSET / AWS_MAGNET_OFFSET / OSS_LOOP_OFFSET are authored on the route
// (route.ts) — re-export them here so `aws.ts` is the single constants face.
export { STARTER_OFFSET, AWS_MAGNET_OFFSET, OSS_LOOP_OFFSET } from "./route";

export const FRONT_OFFSET = 2.0; // legacy front offset (simulation.ts), in travel dir
export const AWS_WARN_WINDOW = 3; // s: ack window (legacy awsDeadline = simTime + 3)
export const OSS_TRIP_SPEED = 13.4; // m/s ≈ 30 mph: OSS overspeed trip threshold

// ── Initial state ────────────────────────────────────────────────────────────

export function createInitialAws(): AwsState {
  return {
    phase: "CLEAR",
    warnTimer: 0,
    sunflower: "BLACK",
    brakeReason: null,
    served: new Set(),
    spad: false,
  };
}

// ── The state machine (one tick, all dt-counted) ─────────────────────────────

/**
 * Advance the AWS/TPWS/SPAD machine by one tick. Pure on its explicit
 * `prevChainage`/`dir`/`dt` (no folded position, no wall-clock). Front position
 * uses `FRONT_OFFSET` in travel direction; all edge logic fires only on strict
 * forward motion (`frontNow > frontPrev`). Deterministic order within the tick:
 *   served → magnet/AWS → TPWS/SPAD → braked-clearing → reasons.
 */
export function tickAws(
  aws: AwsState,
  state: SimState,
  route: Route,
  intent: ControlIntent,
  prevChainage: number,
  dir: 1 | -1,
  dt: number,
): { next: AwsState; reasons: PenaltyReason[]; hud: AwsHud } {
  let { phase, warnTimer, sunflower, brakeReason, served, spad } = aws;
  const atStand = Math.abs(state.speed) <= STAND_EPS;

  const frontNow = state.chainage + dir * FRONT_OFFSET;
  const frontPrev = prevChainage + dir * FRONT_OFFSET;
  const movingFwd = frontNow > frontPrev;

  // 1. Served update: a stand within ±platformHalf of a station's board serves
  //    it (copy-on-write, add-only). Newly serving rings the clear bell.
  if (atStand) {
    for (const station of route.stations) {
      if (served.has(station.name)) continue;
      if (Math.abs(frontNow - station.chainage) <= station.platformHalf) {
        const next = new Set(served);
        next.add(station.name);
        served = next;
        sunflower = "BLACK"; // clear bell on serving a station (R3-1)
      }
    }
  }

  // Derived position arrays, index-aligned with route.signals.
  const posts = route.signals.map((sig) => sig.chainage);
  const magnets = route.signals.map((sig) => sig.chainage - AWS_MAGNET_OFFSET);
  const ossLoops = route.signals.map((sig) => sig.chainage - OSS_LOOP_OFFSET);

  // 2. Magnet crossings — evaluate each crossed signal's aspect over `served`.
  if (movingFwd) {
    for (const i of pointsCrossedFwd(magnets, frontPrev, frontNow)) {
      const aspect = aspectAt(route, i, served);
      if (aspect === "GREEN") {
        // GREEN magnet rings the clear bell; cancels a WARNING; never a brake.
        sunflower = "BLACK";
        if (phase === "WARNING") phase = "CLEAR";
      } else if (brakeReason === null) {
        // non-GREEN magnet — only if not already braked (F6: brake outranks it).
        phase = "WARNING";
        warnTimer = AWS_WARN_WINDOW;
        sunflower = "CAUTION";
      }
    }
  }

  // 3. WARNING countdown.
  if (phase === "WARNING") {
    if (intent.acknowledge) {
      phase = "CLEAR"; // in-window ack (allowed while moving); sunflower stays CAUTION
    } else {
      warnTimer -= dt;
      if (warnTimer <= 0) {
        brakeReason = "AWS"; // now braked; the warning lifecycle is over
        phase = "CLEAR";
      }
    }
  }

  // 4. TPWS / SPAD — swept post + OSS-loop crossings (within-tick: AWS first,
  //    then TSS/SPAD overwrites brakeReason to "TPWS"; TSS is authoritative).
  if (movingFwd) {
    for (const i of pointsCrossedFwd(posts, frontPrev, frontNow)) {
      if (aspectAt(route, i, served) === "RED") {
        brakeReason = "TPWS"; // train physically passed a held-RED starter
        spad = true;
      }
    }
    if (Math.abs(state.speed) > OSS_TRIP_SPEED) {
      for (const i of pointsCrossedFwd(ossLoops, frontPrev, frontNow)) {
        if (aspectAt(route, i, served) === "RED") brakeReason = "TPWS";
      }
    }
  }

  // 5. Braked clearing — NO LAG. Ack at a stand clears the same tick; otherwise
  //    re-assert (ack-while-moving never clears).
  if (brakeReason !== null) {
    if (intent.acknowledge && atStand) {
      brakeReason = null; // released this same tick; sunflower stays CAUTION until next serve
    }
    // else: brakeReason stays — re-asserted via step 6 (survives ack-while-moving).
  }

  // 6. Reasons assembled.
  const reasons: PenaltyReason[] = brakeReason ? [brakeReason] : [];

  // 7. HUD (no aspect — buildHudView derives it from served).
  const hud: AwsHud = { sunflower, spad };

  const next: AwsState = { phase, warnTimer, sunflower, brakeReason, served, spad };
  return { next, reasons, hud };
}
