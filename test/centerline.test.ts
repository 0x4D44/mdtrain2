import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import {
  KINGSGATE_SEAHAVEN,
  WESTFORD_EASTBANK,
  gradeAt,
  curvatureAt,
  speedLimitAt,
} from "../src/sim/route";
import {
  centerlineAt,
  heightAt,
  headingAt,
  planarPoseAt,
  placeOnCentreline,
} from "../src/sim/centerline";

// ── pinned constants (HLD §2.1) ──────────────────────────────────────────────
const CANT_GAIN = 0.08;
const CANT_MAX = 0.105;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Analytic ∫₀ˢ grade du for a route with piecewise-constant grades, by hand
 *  (clipping each segment to [0,s]); independent of the implementation. */
function analyticHeight(route: Route, s: number): number {
  if (s === 0) return 0;
  if (s < 0) {
    const g0 = route.grades[0]?.value ?? 0;
    return g0 * s;
  }
  let h = 0;
  let prev = 0;
  for (const seg of route.grades) {
    const lo = Math.max(seg.from, 0);
    const hi = Math.min(seg.to, s);
    if (hi > lo) h += seg.value * (hi - lo);
    prev = seg.to;
  }
  // s beyond the last segment: extrapolate along the last grade.
  if (s > prev) {
    const gLast = route.grades[route.grades.length - 1]?.value ?? 0;
    h += gLast * (s - prev);
  }
  return h;
}

/** Sorted unique curvature breakpoints strictly inside (0, length). */
function curvatureBreaks(route: Route): number[] {
  const set = new Set<number>();
  for (const seg of route.curvatures) {
    if (seg.from > 0 && seg.from < route.length) set.add(seg.from);
    if (seg.to > 0 && seg.to < route.length) set.add(seg.to);
  }
  return [...set].sort((a, b) => a - b);
}

/** Sorted unique grade breakpoints strictly inside (0, length). */
function gradeBreaks(route: Route): number[] {
  const set = new Set<number>();
  for (const seg of route.grades) {
    if (seg.from > 0 && seg.from < route.length) set.add(seg.from);
    if (seg.to > 0 && seg.to < route.length) set.add(seg.to);
  }
  return [...set].sort((a, b) => a - b);
}

// A straight test route with a couple of pure arcs for closed-form checks.
function straightRoute(length = 6_000): Route {
  return {
    length,
    stations: [],
    grades: [{ from: 0, to: length, value: 0 }],
    speedLimits: [{ from: 0, to: length, value: 20 }],
    curvatures: [{ from: 0, to: length, value: 0 }],
    signals: [],
  };
}

describe("heightAt — ∫ grade (O1–O3)", () => {
  it("O1: matches the analytic integral to ≤1e-9 (mid-segment & at breakpoints)", () => {
    for (const route of [WESTFORD_EASTBANK, KINGSGATE_SEAHAVEN]) {
      const samples: number[] = [];
      for (let s = 0; s <= route.length; s += 137) samples.push(s);
      samples.push(route.length);
      for (const b of gradeBreaks(route)) samples.push(b, b - 1, b + 1);
      for (const s of samples) {
        expect(heightAt(route, s)).toBeCloseTo(analyticHeight(route, s), 9);
      }
    }
  });

  it("O1b: extrapolates linearly outside [0,length] (s<0 first grade; s>length last grade)", () => {
    const route = KINGSGATE_SEAHAVEN;
    const g0 = gradeAt(route, 0);
    const gL = route.grades[route.grades.length - 1]?.value ?? 0;
    expect(heightAt(route, -200)).toBeCloseTo(g0 * -200, 9);
    expect(heightAt(route, route.length + 200)).toBeCloseTo(
      heightAt(route, route.length) + gL * 200,
      9,
    );
  });

  it("O2: d(height)/ds == gradeAt off breakpoints (≤1e-6)", () => {
    const route = KINGSGATE_SEAHAVEN;
    const h = 1e-3;
    for (let s = 50; s <= route.length - 50; s += 311) {
      // avoid landing on a breakpoint
      const onBreak = gradeBreaks(route).some((b) => Math.abs(b - s) < 2 * h);
      if (onBreak) continue;
      const deriv = (heightAt(route, s + h) - heightAt(route, s - h)) / (2 * h);
      expect(deriv).toBeCloseTo(gradeAt(route, s), 6);
    }
  });

  it("O3: C0 continuity at every grade breakpoint (≤1e-9)", () => {
    const route = KINGSGATE_SEAHAVEN;
    // Pick eps so the worst-case slope contribution (|grade|·eps ≤ 0.012·eps)
    // stays well under 1e-9: at eps=1e-8 the jump bound is ≈1.2e-10.
    const eps = 1e-8;
    for (const b of gradeBreaks(route)) {
      const left = heightAt(route, b - eps);
      const right = heightAt(route, b + eps);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-9);
      // the value at the breakpoint equals both one-sided limits (C0) and the
      // analytic integral.
      const here = heightAt(route, b);
      expect(Math.abs(here - left)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(here - right)).toBeLessThanOrEqual(1e-9);
      expect(here).toBeCloseTo(analyticHeight(route, b), 9);
    }
  });
});

describe("tangent & heading (O4)", () => {
  it("O4: tangent is G1 across every curvature breakpoint (≤1e-6) and unit length", () => {
    const route = KINGSGATE_SEAHAVEN;
    const eps = 1e-4;
    for (const b of curvatureBreaks(route)) {
      const tl = centerlineAt(route, b - eps).tangent;
      const tr = centerlineAt(route, b + eps).tangent;
      expect(tl.x).toBeCloseTo(tr.x, 6);
      expect(tl.y).toBeCloseTo(tr.y, 6);
      expect(tl.z).toBeCloseTo(tr.z, 6);
    }
    // ‖tangent‖ ≈ 1 everywhere
    for (let s = 0; s <= route.length; s += 173) {
      const t = centerlineAt(route, s).tangent;
      const n = Math.sqrt(t.x * t.x + t.y * t.y + t.z * t.z);
      expect(n).toBeCloseTo(1, 9);
    }
  });

  it("O4b: heading=0 ⇒ tangent=+Z on a straight route", () => {
    const route = straightRoute();
    const f = centerlineAt(route, 1_000);
    expect(f.heading).toBeCloseTo(0, 12);
    expect(f.tangent.x).toBeCloseTo(0, 12);
    expect(f.tangent.y).toBeCloseTo(0, 12);
    expect(f.tangent.z).toBeCloseTo(1, 12);
    // z(s)=s on a straight (heading 0)
    expect(planarPoseAt(route, 1_000).z).toBeCloseTo(1_000, 9);
    expect(planarPoseAt(route, 1_000).x).toBeCloseTo(0, 12);
  });
});

describe("planar pose closed forms (O5, O5b)", () => {
  it("O5: single arc from ψ₀=0 ⇒ x≈R(1-cosθ), z≈R sinθ", () => {
    const kappa = 1 / 800;
    const R = 1 / kappa;
    const L = 600;
    const theta = kappa * L;
    const route: Route = {
      length: 2_000,
      stations: [],
      grades: [{ from: 0, to: 2_000, value: 0 }],
      speedLimits: [{ from: 0, to: 2_000, value: 20 }],
      curvatures: [{ from: 0, to: 2_000, value: kappa }],
      signals: [],
    };
    const p = planarPoseAt(route, L);
    expect(p.x).toBeCloseTo(R * (1 - Math.cos(theta)), 6);
    expect(p.z).toBeCloseTo(R * Math.sin(theta), 6);
    expect(p.heading).toBeCloseTo(theta, 9);
    expect(headingAt(route, L)).toBeCloseTo(theta, 9);
  });

  it("O5b: two-arc compounded pose matches a hand-rotation of the 2nd arc by ψ₀", () => {
    const k1 = 1 / 800;
    const L1 = 800; // first arc, length up to its end
    const k2 = 1 / 500;
    const L2 = 400; // second arc (different κ), continues from ψ₀=θ1
    const route: Route = {
      length: 4_000,
      stations: [],
      grades: [{ from: 0, to: 4_000, value: 0 }],
      speedLimits: [{ from: 0, to: 4_000, value: 20 }],
      curvatures: [
        { from: 0, to: L1, value: k1 },
        { from: L1, to: 4_000, value: k2 },
      ],
      signals: [],
    };
    // Hand computation: arc1 from ψ0=0, then arc2 from ψ0=θ1.
    const th1 = k1 * L1;
    let x = (Math.cos(0) - Math.cos(th1)) / k1;
    let z = (Math.sin(th1) - Math.sin(0)) / k1;
    const psi1 = th1;
    const th2 = k2 * L2;
    x += (Math.cos(psi1) - Math.cos(psi1 + th2)) / k2;
    z += (Math.sin(psi1 + th2) - Math.sin(psi1)) / k2;
    const psi2 = psi1 + th2;

    const p = planarPoseAt(route, L1 + L2);
    expect(p.x).toBeCloseTo(x, 6);
    expect(p.z).toBeCloseTo(z, 6);
    expect(p.heading).toBeCloseTo(psi2, 9);
  });
});

describe("placeOnCentreline (O5c)", () => {
  it("O5c: places exactly |d| from the spine, perpendicular, with the correct sign", () => {
    const route = straightRoute();
    const s = 2_000;
    const base = planarPoseAt(route, s);
    // On a straight (heading=0): right = (cos0, -sin0) = (+1, 0). d=-0.5 ⇒ x=-0.5.
    const left = placeOnCentreline(route, s, -0.5);
    expect(left.x).toBeCloseTo(-0.5, 12);
    expect(left.z).toBeCloseTo(base.z, 9);
    expect(left.heading).toBeCloseTo(0, 12);
    const right = placeOnCentreline(route, s, +0.5);
    expect(right.x).toBeCloseTo(+0.5, 12);

    // Generic: distance from spine == |d|, perpendicular to the tangent.
    const route2 = KINGSGATE_SEAHAVEN;
    for (const sc of [1_000, 5_000, 6_000, 9_000, 12_000]) {
      const spine = planarPoseAt(route2, sc);
      for (const d of [-3, -0.5, 0.5, 7]) {
        const q = placeOnCentreline(route2, sc, d);
        const dx = q.x - spine.x;
        const dz = q.z - spine.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeCloseTo(Math.abs(d), 6);
        // perpendicular to tangent (sin ψ, cos ψ)
        const tx = Math.sin(spine.heading);
        const tz = Math.cos(spine.heading);
        const dot = dx * tx + dz * tz;
        expect(dot).toBeCloseTo(0, 6);
        // y == heightAt(s)
        expect(q.y).toBeCloseTo(heightAt(route2, sc), 9);
        // no +π applied here — heading is the mathematical heading
        expect(q.heading).toBeCloseTo(headingAt(route2, sc), 12);
      }
    }
  });
});

describe("cant (O6)", () => {
  it("O6: below-clamp equals the signed formula; over-clamp equals ±CANT_MAX; sign follows κ", () => {
    const route = KINGSGATE_SEAHAVEN;
    // Below-clamp: a gentle real curve on the route (Wealdham sweep, R=700).
    const sCurve = 5_000; // inside [4800,5500) κ=+1/700
    const k = curvatureAt(route, sCurve);
    const v = speedLimitAt(route, sCurve);
    const expected = CANT_GAIN * Math.abs(k) * v * v * Math.sign(k);
    expect(k).toBeGreaterThan(0);
    expect(Math.abs(expected)).toBeLessThan(CANT_MAX); // genuinely below the clamp
    expect(centerlineAt(route, sCurve).cant).toBeCloseTo(expected, 9);

    // Straight ⇒ cant 0 (s=6000 is on the long [5500,9200) straight).
    expect(centerlineAt(route, 6_000).cant).toBeCloseTo(0, 12);

    // Over-clamp (synthetic): big κ and v force the magnitude past CANT_MAX,
    // and the sign must follow κ.
    const hot: Route = {
      length: 1_000,
      stations: [],
      grades: [{ from: 0, to: 1_000, value: 0 }],
      speedLimits: [{ from: 0, to: 1_000, value: 60 }],
      curvatures: [
        { from: 0, to: 500, value: 1 / 100 }, // positive, hot
        { from: 500, to: 1_000, value: -1 / 100 }, // negative, hot
      ],
      signals: [],
    };
    const raw = CANT_GAIN * (1 / 100) * 60 * 60;
    expect(raw).toBeGreaterThan(CANT_MAX); // pre-condition: this saturates
    expect(centerlineAt(hot, 250).cant).toBeCloseTo(CANT_MAX, 9);
    expect(centerlineAt(hot, 750).cant).toBeCloseTo(-CANT_MAX, 9);
  });
});

describe("Frame integration", () => {
  it("centerlineAt bundles x/y/z, tangent, up, heading, cant consistently", () => {
    const route = KINGSGATE_SEAHAVEN;
    for (const s of [0, 2_000, 5_000, 8_050, 11_700, 14_000]) {
      const f = centerlineAt(route, s);
      const pose = planarPoseAt(route, s);
      expect(f.x).toBeCloseTo(pose.x, 9);
      expect(f.z).toBeCloseTo(pose.z, 9);
      expect(f.y).toBeCloseTo(heightAt(route, s), 9);
      expect(f.heading).toBeCloseTo(headingAt(route, s), 12);
      // up is a unit vector
      const un = Math.sqrt(f.up.x * f.up.x + f.up.y * f.up.y + f.up.z * f.up.z);
      expect(un).toBeCloseTo(1, 9);
    }
  });
});
