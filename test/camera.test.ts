// Camera oracles (HLD §2.1b): the pure eye + cab-attitude layer. No GPU, no
// Three.js — O5d proves the render-side +π yaw convention by computing a YXZ
// rotation BY HAND (a tiny local applyYaw helper) and checking the camera's
// default-forward (0,0,−1) is rotated to (0,0,+1) when heading=0. O16 pins the
// cab-attitude clamp non-tautologically (below-clamp equals the formula; huge
// synthetic inputs saturate the ceilings; scale=0 ⇒ {0,0}).

import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import {
  EYE_HEIGHT,
  EYE_D,
  cabAttitudeTarget,
  eyePose,
} from "../src/sim/camera";

// ── pinned constants (HLD §2.1b) ─────────────────────────────────────────────
const PITCH_MAX = 0.052;
const ROLL_MAX = 0.07;

// ── a minimal, dead-straight, dead-level synthetic route ─────────────────────
// heading ≡ 0 (no curvature) and y ≡ 0 (no grade) ⇒ z(s)=s exactly, and the
// near-track ground = formation + BALLAST_DROP = −0.4 (no bands), so the eye
// floor is −0.4 + 0.5 = 0.1 ≪ EYE_HEIGHT — clampEye leaves the lifted eye alone.
const STRAIGHT: Route = {
  length: 1_000,
  stations: [
    { name: "A", chainage: 0, platformHalf: 90 },
    { name: "B", chainage: 1_000, platformHalf: 90 },
  ],
  grades: [{ from: 0, to: 1_000, value: 0 }],
  speedLimits: [{ from: 0, to: 1_000, value: 20 }],
  curvatures: [{ from: 0, to: 1_000, value: 0 }],
  signals: [],
};

// ── a tiny by-hand YXZ yaw helper (NO Three.js) ──────────────────────────────
// Three's Euler "YXZ" with pitch=roll=0 is a pure rotation about +Y by `yaw`.
// Applying it to a column vector v: R_y(yaw)·v with
//   R_y = [[ cosθ, 0, sinθ], [0,1,0], [−sinθ, 0, cosθ]].
function applyYaw(
  yaw: number,
  v: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: c * v.x + s * v.z,
    y: v.y,
    z: -s * v.x + c * v.z,
  };
}

describe("O5d — heading semantics & the +π yaw convention (PURE, no GPU)", () => {
  it("straight route ⇒ heading=0 and eyePose.z(s)=s for eyeD=0", () => {
    for (let s = 0; s <= STRAIGHT.length; s += 50) {
      const eye = eyePose(STRAIGHT, s, 0, EYE_HEIGHT);
      expect(eye.heading).toBeCloseTo(0, 12);
      expect(eye.z).toBeCloseTo(s, 9);
      expect(eye.x).toBeCloseTo(0, 9);
      // y is the formation lift, floored by clampEye; here the lift dominates.
      expect(eye.y).toBeCloseTo(EYE_HEIGHT, 9);
    }
  });

  it("a YXZ yaw of (heading+π) turns the camera default-forward (0,0,−1) to (0,0,+1) when heading=0", () => {
    const eye = eyePose(STRAIGHT, 500, EYE_D, EYE_HEIGHT);
    expect(eye.heading).toBeCloseTo(0, 12);
    // Three cameras look down −Z by default; the render layer yaws by heading+π.
    const yaw = eye.heading + Math.PI;
    const forward = applyYaw(yaw, { x: 0, y: 0, z: -1 });
    expect(forward.x).toBeCloseTo(0, 12);
    expect(forward.y).toBeCloseTo(0, 12);
    expect(forward.z).toBeCloseTo(1, 12); // looks +Z, DOWN the line — not backward
  });

  it("control: WITHOUT the +π the camera would look backward (−Z) — proves +π is load-bearing", () => {
    const eye = eyePose(STRAIGHT, 500, EYE_D, EYE_HEIGHT);
    const forwardNoPi = applyYaw(eye.heading, { x: 0, y: 0, z: -1 });
    expect(forwardNoPi.z).toBeCloseTo(-1, 12); // would look backward up the line
  });
});

describe("O5c-sign (camera) — eyeD sign is preserved laterally on a straight", () => {
  it("EYE_D = −0.5 ⇒ eyePose.x = −0.5 on a straight (driver on the left)", () => {
    const eye = eyePose(STRAIGHT, 200, EYE_D, EYE_HEIGHT);
    expect(eye.x).toBeCloseTo(EYE_D, 9); // right = (cos0,−sin0)=(1,0) ⇒ x = 0 + d·1
    expect(eye.z).toBeCloseTo(200, 9);
  });
});

describe("O16 — cab attitude pinned + non-tautological", () => {
  it("below-clamp: pitch = scale·atan(grade), roll = scale·cant", () => {
    const scale = 0.35;
    // gentle, in-range inputs (well under the ceilings)
    const cases: Array<{ cant: number; grade: number }> = [
      { cant: 0.02, grade: 0.01 },
      { cant: -0.03, grade: -0.015 },
      { cant: 0.0, grade: 0.005 },
      { cant: 0.05, grade: 0.0 },
    ];
    for (const { cant, grade } of cases) {
      const a = cabAttitudeTarget(cant, grade, scale);
      expect(a.pitch).toBeCloseTo(scale * Math.atan(grade), 12);
      expect(a.roll).toBeCloseTo(scale * cant, 12);
      // and these are genuinely below the ceilings (non-tautology guard)
      expect(Math.abs(a.pitch)).toBeLessThan(PITCH_MAX);
      expect(Math.abs(a.roll)).toBeLessThan(ROLL_MAX);
    }
  });

  it("over-clamp: a huge grade saturates pitch at ±PITCH_MAX; a huge cant saturates roll at ±ROLL_MAX", () => {
    const scale = 1; // big scale + big inputs blow past the ceilings
    expect(cabAttitudeTarget(0, 1_000, scale).pitch).toBe(PITCH_MAX);
    expect(cabAttitudeTarget(0, -1_000, scale).pitch).toBe(-PITCH_MAX);
    expect(cabAttitudeTarget(1_000, 0, scale).roll).toBe(ROLL_MAX);
    expect(cabAttitudeTarget(-1_000, 0, scale).roll).toBe(-ROLL_MAX);
    // mixed: both ceilings hit at once
    const both = cabAttitudeTarget(50, 50, 10);
    expect(both.pitch).toBe(PITCH_MAX);
    expect(both.roll).toBe(ROLL_MAX);
  });

  it("scale=0 ⇒ {pitch:0, roll:0} regardless of cant/grade (coarse & reduced-motion path)", () => {
    for (const { cant, grade } of [
      { cant: 0.05, grade: 0.02 },
      { cant: -1_000, grade: 1_000 },
      { cant: 0, grade: 0 },
    ]) {
      const a = cabAttitudeTarget(cant, grade, 0);
      // exact zero — use === so the legitimate −0 (e.g. 0·−1000) counts as zero.
      expect(a.pitch === 0).toBe(true);
      expect(a.roll === 0).toBe(true);
    }
  });

  it("just at the ceiling: scale·atan(grade) === PITCH_MAX passes through unclamped", () => {
    // choose grade so scale·atan(grade) is just below PITCH_MAX, then exactly at.
    const scale = 1;
    const gradeAtMax = Math.tan(PITCH_MAX / scale); // atan(grade)·scale = PITCH_MAX
    const a = cabAttitudeTarget(0, gradeAtMax, scale);
    expect(a.pitch).toBeCloseTo(PITCH_MAX, 12);
    expect(a.pitch).toBeLessThanOrEqual(PITCH_MAX);
  });
});
