// The path layer (HLD §2.1): the route's centreline as a pure function of
// chainage s. Everything here is integral geometry on the 1-D route data —
// height = ∫grade, heading = ∫curvature, planar pose accumulated arc-by-arc —
// computed on Node with no Three.js, no DOM, no clock and no randomness. The
// render layer projects what this layer computes; the physics layer never
// reads it (R6). Trig + sqrt only.

import type { Route } from "./route";
import { gradeAt, curvatureAt, speedLimitAt } from "./route";

/** A 3-D vector with no Three.js dependency. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A full pose frame on the centreline at chainage s. */
export interface Frame {
  x: number;
  y: number;
  z: number;
  /** Unit tangent (sin ψ, 0, cos ψ): heading=0 ⇒ +Z. */
  tangent: Vec3;
  /** Unit up vector. */
  up: Vec3;
  /** Mathematical track heading ψ, rad (heading=0 ⇒ tangent=+Z). */
  heading: number;
  /** Signed superelevation, rad (sign follows curvature). */
  cant: number;
}

// ── pinned constants (HLD §2.1) ──────────────────────────────────────────────
/** Cant gain: cant = clamp(CANT_GAIN·|κ|·v², CANT_MAX), signed by κ. */
const CANT_GAIN = 0.08;
/** Maximum superelevation, rad. */
const CANT_MAX = 0.105;
/** A curvature below this magnitude is treated as straight (avoids 1/κ blow-up). */
const STRAIGHT_EPS = 1e-12;

function clampAbs(v: number, max: number): number {
  if (v > max) return max;
  if (v < -max) return -max;
  return v;
}

/**
 * Height above the origin datum: ∫₀ˢ gradeAt(u) du. Grades are piecewise
 * constant, so the integral is piecewise-linear and C0. `gradeAt` already
 * clamps to the end segments, so for s<0 the first grade extrapolates and for
 * s>length the last grade extrapolates — the integral continues straight off
 * each end (O-DOMAIN, O1b).
 */
export function heightAt(route: Route, s: number): number {
  if (s === 0) return 0;

  if (s < 0) {
    // ∫₀ˢ with s<0: the integral runs backwards along the first grade.
    return gradeAt(route, 0) * s;
  }

  let h = 0;
  let covered = 0; // chainage covered so far within [0, s]
  for (const seg of route.grades) {
    const lo = Math.max(seg.from, 0);
    const hi = Math.min(seg.to, s);
    if (hi > lo) {
      h += seg.value * (hi - lo);
      covered = hi;
    }
  }
  // s beyond the last grade segment: extrapolate along the last grade.
  if (s > covered) {
    h += gradeAt(route, s) * (s - covered);
  }
  return h;
}

/**
 * The running planar pose at chainage s: world (x, z) and heading ψ, accumulated
 * curvature-segment by curvature-segment. Each segment's LOCAL arc displacement
 * is rotated by the entry heading ψ₀ before being added, and ψ carries across
 * every breakpoint (so the tangent is G1 — O4). `curvatureAt` clamps to the end
 * segments, so the pose extrapolates straight off each end (O-DOMAIN).
 */
export function planarPoseAt(
  route: Route,
  s: number,
): { x: number; z: number; heading: number } {
  let x = 0;
  let z = 0;
  let psi = 0; // ψ₀ = 0 at s=0

  if (s === 0) return { x, z, heading: psi };

  const step = (kappa: number, L: number): void => {
    if (L === 0) return;
    if (Math.abs(kappa) < STRAIGHT_EPS) {
      // Straight: advance L along the current heading. tangent=(sin ψ, cos ψ).
      x += L * Math.sin(psi);
      z += L * Math.cos(psi);
    } else {
      // Arc: rotate the local displacement by the entry heading ψ₀ (=psi).
      const theta = kappa * L;
      x += (Math.cos(psi) - Math.cos(psi + theta)) / kappa;
      z += (Math.sin(psi + theta) - Math.sin(psi)) / kappa;
      psi += theta;
    }
  };

  if (s < 0) {
    // Before the start: one straight (extrapolated) step of negative length
    // along the entry tangent (curvatureAt clamps to the first segment).
    step(curvatureAt(route, 0), s);
    return { x, z, heading: psi };
  }

  let covered = 0;
  for (const seg of route.curvatures) {
    const lo = Math.max(seg.from, 0);
    const hi = Math.min(seg.to, s);
    if (hi > lo) {
      step(seg.value, hi - lo);
      covered = hi;
    }
  }
  // s beyond the last curvature segment: extrapolate along the clamped tangent.
  if (s > covered) {
    step(curvatureAt(route, s), s - covered);
  }

  return { x, z, heading: psi };
}

/**
 * The mathematical track heading ψ(s) = ψ₀ + ∫₀ˢ curvatureAt du, rad.
 * heading=0 ⇒ tangent=+Z. ψ₀ = 0 at s = 0.
 */
export function headingAt(route: Route, s: number): number {
  return planarPoseAt(route, s).heading;
}

/**
 * The signed cant (superelevation) at s: clamp(CANT_GAIN·|κ|·v_ref², CANT_MAX)
 * carrying the sign of κ (O6). v_ref = speedLimitAt(s).
 */
function cantAt(route: Route, s: number): number {
  const kappa = curvatureAt(route, s);
  const v = speedLimitAt(route, s);
  const magnitude = CANT_GAIN * Math.abs(kappa) * v * v;
  const signed = Math.sign(kappa) * magnitude;
  return clampAbs(signed, CANT_MAX);
}

/**
 * The full pose frame at chainage s: position, unit tangent/up, mathematical
 * heading and signed cant.
 */
export function centerlineAt(route: Route, s: number): Frame {
  const pose = planarPoseAt(route, s);
  const y = heightAt(route, s);
  const tangent: Vec3 = {
    x: Math.sin(pose.heading),
    y: 0,
    z: Math.cos(pose.heading),
  };
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  return {
    x: pose.x,
    y,
    z: pose.z,
    tangent,
    up,
    heading: pose.heading,
    cant: cantAt(route, s),
  };
}

/**
 * The single placement primitive (HLD §2.1): the world point a lateral offset d
 * from the spine at chainage s, perpendicular to the tangent. right = (cos ψ,
 * −sin ψ), so on a straight (ψ=0) d=−0.5 ⇒ x=−0.5 (O5c sign). y = heightAt(s).
 * Returns the MATHEMATICAL heading — Three facing offsets (+π) are render-side
 * (D21).
 */
export function placeOnCentreline(
  route: Route,
  s: number,
  d: number,
): { x: number; y: number; z: number; heading: number } {
  const pose = planarPoseAt(route, s);
  // right-hand normal to the tangent (sin ψ, cos ψ) is (cos ψ, −sin ψ).
  const rx = Math.cos(pose.heading);
  const rz = -Math.sin(pose.heading);
  return {
    x: pose.x + d * rx,
    y: heightAt(route, s),
    z: pose.z + d * rz,
    heading: pose.heading,
  };
}
