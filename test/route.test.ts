import { describe, it, expect } from "vitest";
import type { Route, Segment } from "../src/sim/route";
import {
  KINGSGATE_SEAHAVEN,
  WESTFORD_EASTBANK,
  STARTER_OFFSET,
  minCurveRadius,
  speedLimitAt,
} from "../src/sim/route";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A fully-straight route fixture (every curvature segment value 0). */
function straightRoute(): Route {
  return {
    length: 6_000,
    stations: [],
    grades: [{ from: 0, to: 6_000, value: 0 }],
    speedLimits: [{ from: 0, to: 6_000, value: 20 }],
    curvatures: [
      { from: 0, to: 3_000, value: 0 },
      { from: 3_000, to: 6_000, value: 0 },
    ],
    signals: [],
  };
}

/** A band [center−halfLen, center+halfLen] lies wholly within curvature
 *  segments that are ALL κ=0 (O19b): every segment that overlaps the band has
 *  value 0, and the band is fully covered by such segments. */
function bandOnStraight(
  curvatures: Segment<number>[],
  center: number,
  halfLen: number,
): boolean {
  const lo = center - halfLen;
  const hi = center + halfLen;
  // Every overlapping segment must be straight.
  const overlapping = curvatures.filter((seg) => seg.to > lo && seg.from < hi);
  if (overlapping.some((seg) => seg.value !== 0)) return false;
  // The straight overlapping segments must cover [lo, hi] with no gap.
  const sorted = [...overlapping].sort((a, b) => a.from - b.from);
  let cursor = lo;
  for (const seg of sorted) {
    if (seg.from > cursor + 1e-9) return false; // gap before this segment
    cursor = Math.max(cursor, seg.to);
    if (cursor >= hi - 1e-9) return true;
  }
  return cursor >= hi - 1e-9;
}

/** Contiguous-ascending cover of [0, length]: segments sorted, no gaps/overlaps,
 *  first.from===0, last.to===length, every from<to. */
function coversContiguously(segs: Segment<unknown>[], length: number): boolean {
  if (segs.length === 0) return false;
  const sorted = [...segs].sort((a, b) => a.from - b.from);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return false;
  if (first.from !== 0 || last.to !== length) return false;
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    if (!seg) return false;
    if (!(seg.from < seg.to)) return false; // strictly ascending interval
    if (i > 0) {
      const prev = sorted[i - 1];
      if (!prev || prev.to !== seg.from) return false; // contiguous, no gap/overlap
    }
  }
  return true;
}

// ── minCurveRadius ───────────────────────────────────────────────────────────

describe("minCurveRadius: tightest non-zero curve, +Infinity if all straight", () => {
  it("WESTFORD_EASTBANK === 250 (its 1/250 curve is the tightest)", () => {
    expect(minCurveRadius(WESTFORD_EASTBANK)).toBeCloseTo(250, 9);
  });

  it("KINGSGATE_SEAHAVEN >= 250 (the grand route's tightened curvature floor)", () => {
    expect(minCurveRadius(KINGSGATE_SEAHAVEN)).toBeGreaterThanOrEqual(250);
  });

  it("an all-straight route ⇒ +Infinity (no non-zero curvature)", () => {
    expect(minCurveRadius(straightRoute())).toBe(Infinity);
  });
});

// ── O19 / curve-richness: bends often, every curve R >= 250, PSR off the cant cap ──

describe("O19/curve-richness: KINGSGATE_SEAHAVEN bends often, every curve R >= 250 m", () => {
  const curves = KINGSGATE_SEAHAVEN.curvatures.filter((s) => s.value !== 0);

  it("every curve is straight or radius >= 250 m (O-RIBBON @ desktop 120)", () => {
    for (const seg of curves) {
      expect(1 / Math.abs(seg.value)).toBeGreaterThanOrEqual(250);
    }
    expect(curves.length).toBeGreaterThan(0); // non-vacuous
  });

  it(">= 5 non-zero curvature segments (no longer a ruler)", () => {
    expect(curves.length).toBeGreaterThanOrEqual(5);
  });

  it(">= 1 tight curve with R < 400 m", () => {
    expect(curves.some((s) => 1 / Math.abs(s.value) < 400)).toBe(true);
  });

  it(">= 1 S-bend (adjacent curvature segments of opposite sign)", () => {
    const segs = KINGSGATE_SEAHAVEN.curvatures;
    let sBends = 0;
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1];
      const b = segs[i];
      if (a && b && a.value !== 0 && b.value !== 0 && Math.sign(a.value) !== Math.sign(b.value)) {
        sBends++;
      }
    }
    expect(sBends).toBeGreaterThanOrEqual(1);
  });

  it("AC-4b PSR: each curve's posted speed keeps cant off the ceiling (0.08·|κ|·v² <= 0.105)", () => {
    const CANT_GAIN = 0.08;
    const CANT_MAX = 0.105;
    for (const seg of curves) {
      // Sample the posted speed ACROSS the whole curve span and take the max —
      // robust to a speed-limit boundary later shifting into the middle of a curve
      // (a midpoint-only check could miss a faster sub-segment at the curve edge).
      let vMax = 0;
      const N = 8;
      for (let j = 0; j <= N; j++) {
        const s = Math.min(seg.from + (j / N) * (seg.to - seg.from), seg.to - 1e-6);
        vMax = Math.max(vMax, speedLimitAt(KINGSGATE_SEAHAVEN, s)); // m/s
      }
      const cant = CANT_GAIN * Math.abs(seg.value) * vMax * vMax;
      expect(cant).toBeLessThanOrEqual(CANT_MAX);
    }
  });
});

// ── O19b: viaduct/tunnel bands sit wholly on κ=0 spans ───────────────────────

describe("O19b: each viaduct/tunnel band lies wholly within κ=0 curvature", () => {
  it("every viaduct band is on a straight span", () => {
    const viaducts = KINGSGATE_SEAHAVEN.viaducts ?? [];
    expect(viaducts.length).toBeGreaterThan(0);
    for (const v of viaducts) {
      expect(
        bandOnStraight(KINGSGATE_SEAHAVEN.curvatures, v.center, v.halfLen),
        `viaduct @${v.center}±${v.halfLen} must be on κ=0`,
      ).toBe(true);
    }
  });

  it("every tunnel band is on a straight span", () => {
    const tunnels = KINGSGATE_SEAHAVEN.tunnels ?? [];
    expect(tunnels.length).toBeGreaterThan(0);
    for (const t of tunnels) {
      expect(
        bandOnStraight(KINGSGATE_SEAHAVEN.curvatures, t.center, t.halfLen),
        `tunnel @${t.center}±${t.halfLen} must be on κ=0`,
      ).toBe(true);
    }
  });
});

// ── sign convention (HLD §2.5) ───────────────────────────────────────────────

describe("sign convention: valleyDepth>0 (ground below), hillHeight>0 (ground above)", () => {
  it("KINGSGATE_SEAHAVEN viaduct valleyDepth > 0 and tunnel hillHeight > 0", () => {
    const v0 = KINGSGATE_SEAHAVEN.viaducts?.[0];
    const t0 = KINGSGATE_SEAHAVEN.tunnels?.[0];
    expect(v0).toBeDefined();
    expect(t0).toBeDefined();
    expect(v0?.valleyDepth).toBeGreaterThan(0); // ground BELOW formation
    expect(t0?.hillHeight).toBeGreaterThan(0); // ground ABOVE formation
  });

  it("the Wyre Viaduct & Stonehead Tunnel bands match the pinned §2.5 data", () => {
    expect(KINGSGATE_SEAHAVEN.viaducts?.[0]).toEqual({
      center: 8_050,
      halfLen: 320,
      valleyDepth: 45,
    });
    expect(KINGSGATE_SEAHAVEN.tunnels?.[0]).toEqual({
      center: 11_700,
      halfLen: 380,
      hillHeight: 60,
    });
    expect(KINGSGATE_SEAHAVEN.terrainSeed).toBe(1);
  });
});

// ── sanity: stations, profiles, signals ──────────────────────────────────────

describe("KINGSGATE_SEAHAVEN structural sanity", () => {
  it("~14 km, the named chapters present", () => {
    expect(KINGSGATE_SEAHAVEN.length).toBe(14_000);
    const names = KINGSGATE_SEAHAVEN.stations.map((s) => s.name);
    for (const expected of [
      "Kingsgate",
      "Ashcombe",
      "Wealdham",
      "Brinemouth",
      "Seahaven",
    ]) {
      expect(names).toContain(expected);
    }
    expect(KINGSGATE_SEAHAVEN.stations.length).toBeGreaterThanOrEqual(5);
    expect(KINGSGATE_SEAHAVEN.stations.length).toBeLessThanOrEqual(6);
  });

  it("every station is within [0, length]", () => {
    for (const st of KINGSGATE_SEAHAVEN.stations) {
      expect(st.chainage).toBeGreaterThanOrEqual(0);
      expect(st.chainage).toBeLessThanOrEqual(KINGSGATE_SEAHAVEN.length);
    }
  });

  it("grades/speedLimits/curvatures cover [0, length] contiguously ascending", () => {
    const L = KINGSGATE_SEAHAVEN.length;
    expect(coversContiguously(KINGSGATE_SEAHAVEN.grades, L)).toBe(true);
    expect(coversContiguously(KINGSGATE_SEAHAVEN.speedLimits, L)).toBe(true);
    expect(coversContiguously(KINGSGATE_SEAHAVEN.curvatures, L)).toBe(true);
  });

  it("grades are gentle (|grade| <= 0.02)", () => {
    for (const seg of KINGSGATE_SEAHAVEN.grades) {
      expect(Math.abs(seg.value)).toBeLessThanOrEqual(0.02);
    }
  });

  it("signals ascend, are station starters (board + STARTER_OFFSET), none at 0 or length", () => {
    const sigs = KINGSGATE_SEAHAVEN.signals;
    expect(sigs.length).toBeGreaterThan(0);
    for (let i = 1; i < sigs.length; i++) {
      const prev = sigs[i - 1];
      const cur = sigs[i];
      expect(prev && cur && cur.chainage > prev.chainage).toBe(true); // strictly ascending
    }
    const byName = new Map(
      KINGSGATE_SEAHAVEN.stations.map((s) => [s.name, s.chainage] as const),
    );
    for (const sig of sigs) {
      // No starter at either terminus.
      expect(sig.chainage).not.toBe(0);
      expect(sig.chainage).not.toBe(KINGSGATE_SEAHAVEN.length);
      // Post = protected station board + STARTER_OFFSET.
      const board = byName.get(sig.protects);
      expect(board).toBeDefined();
      if (board !== undefined) {
        expect(sig.chainage).toBe(board + STARTER_OFFSET);
      }
    }
    // The origin (Kingsgate) and final terminus (Seahaven) get no starter.
    const protectedSet = new Set(sigs.map((s) => s.protects));
    expect(protectedSet.has("Kingsgate")).toBe(false);
    expect(protectedSet.has("Seahaven")).toBe(false);
  });
});

// ── WESTFORD_EASTBANK left untouched (no new optional fields) ─────────────────

describe("WESTFORD_EASTBANK stays a bare physics/signalling fixture", () => {
  it("omits the optional terrain fields (viaducts/tunnels/terrainSeed)", () => {
    expect(WESTFORD_EASTBANK.viaducts).toBeUndefined();
    expect(WESTFORD_EASTBANK.tunnels).toBeUndefined();
    expect(WESTFORD_EASTBANK.terrainSeed).toBeUndefined();
    expect(WESTFORD_EASTBANK.length).toBe(6_000);
  });
});
