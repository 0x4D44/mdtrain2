// The camera layer (HLD §2.1b): the driver's eye and the cab's banked attitude,
// as pure functions of route data in curvilinear coordinates. It composes the
// path primitive (placeOnCentreline) with the ground floor (clampEye) — importing
// BOTH centreline and terrain — and resolves the ESM cycle by being its own
// module (D1''). No Three.js, no DOM, no clock, no randomness: the render layer
// applies the Three facing offset (heading+π, D21) and eases the attitude.

import type { Route } from "./route";
import { placeOnCentreline } from "./centerline";
import { clampEye } from "./terrain";

// ── pinned constants (HLD §2.1b) ─────────────────────────────────────────────
/** Driver's eye height above the formation, m. */
export const EYE_HEIGHT = 1.9;
/** Driver's lateral eye offset from the spine, m. UK driver-left: the render
 *  camera yaws heading+π, so camera-local +X maps to world −X (screen-right =
 *  world −X). Therefore world +X (EYE_D = +0.5) renders to the screen-LEFT — the
 *  driver sits front-left and the track centre (d=0) reads slightly RIGHT of
 *  centre. (camera.test.ts O5c pins this sign by a by-hand screen projection.) */
export const EYE_D = 0.5;
/** Maximum eased cab pitch (rad). */
const PITCH_MAX = 0.052;
/** Maximum eased cab roll (rad). */
const ROLL_MAX = 0.07;

/** Symmetric clamp of v into [−max, max]. */
function clampAbs(v: number, max: number): number {
  if (v > max) return max;
  if (v < -max) return -max;
  return v;
}

/**
 * The cab-attitude TARGET the render layer eases toward each frame (HLD §2.1b):
 *   pitch = clamp(scale·atan(grade), ±PITCH_MAX)
 *   roll  = clamp(scale·cant,        ±ROLL_MAX)
 * `scale` is the tier's attitudeScale (0.35 desktop, 0 coarse/reduced-motion).
 * Pure clamp; eased render-side. In the live path cant ≤ CANT_MAX and grades are
 * gentle, so the ceilings are defensive — O16 exercises them with synthetic
 * over-clamp inputs.
 */
export function cabAttitudeTarget(
  cant: number,
  grade: number,
  scale: number,
): { pitch: number; roll: number } {
  return {
    pitch: clampAbs(scale * Math.atan(grade), PITCH_MAX),
    roll: clampAbs(scale * cant, ROLL_MAX),
  };
}

/**
 * The driver's eye pose at chainage s (HLD §2.1b): placeOnCentreline(s, eyeD)
 * lifted by eyeHeight, with the Y floored above the ground by clampEye so the eye
 * never sinks into the terrain. The returned `heading` is the MATHEMATICAL track
 * heading (heading=0 ⇒ +Z); the render layer applies the Three facing offset
 * (rotation.y = heading + π, so the camera looks +Z down the line — D21/O5d).
 */
export function eyePose(
  route: Route,
  s: number,
  eyeD: number,
  eyeHeight: number,
): { x: number; y: number; z: number; heading: number } {
  const place = placeOnCentreline(route, s, eyeD);
  const liftedY = place.y + eyeHeight;
  return {
    x: place.x,
    y: clampEye(route, s, eyeD, liftedY),
    z: place.z,
    heading: place.heading,
  };
}
