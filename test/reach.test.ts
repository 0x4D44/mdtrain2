import { describe, it, expect } from "vitest";
import { motionParams } from "../src/ui/motion";
import {
  qualityFor,
  lodForDistance,
  ribbonVertexCount,
  HIGH_BUDGET,
  LOW_BUDGET,
} from "../src/render/quality";
import type { QualitySettings } from "../src/render/quality";

// ── ACC: reduced-motion params ───────────────────────────────────────────────
describe("ACC: motionParams gates rain + wiper on prefers-reduced-motion", () => {
  it("motionParams(true) === { rainScale: 0, wiperEnabled: false }", () => {
    expect(motionParams(true)).toEqual({ rainScale: 0, wiperEnabled: false });
  });

  it("motionParams(false) === { rainScale: 1, wiperEnabled: true }", () => {
    expect(motionParams(false)).toEqual({ rainScale: 1, wiperEnabled: true });
  });
});

// ── QUAL: performance tier ───────────────────────────────────────────────────
describe("QUAL: qualityFor maps device → pixel-ratio cap + rain count", () => {
  it("desktop ⇒ exactly the full desktop QualitySettings", () => {
    expect(
      qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false }),
    ).toEqual({
      pixelRatioCap: 2,
      rainCount: 2400,
      shadowsEnabled: true,
      bloomEnabled: true,
      ribbonHalfWidth: 120,
      terrainSegLen: 8,
      terrainSubdiv: 24,
      attitudeScale: 0.35,
    });
  });

  it("desktop with high DPR is still capped at 2", () => {
    const q = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 3, reducedMotion: false });
    expect(q.pixelRatioCap).toBe(2);
    expect(q.rainCount).toBe(2400);
  });

  it("coarse-pointer ⇒ lower cap and fewer particles than desktop", () => {
    const desktop = qualityFor({
      coarsePointer: false,
      maxDevicePixelRatio: 3,
      reducedMotion: false,
    });
    const mobile = qualityFor({
      coarsePointer: true,
      maxDevicePixelRatio: 3,
      reducedMotion: false,
    });
    expect(mobile.pixelRatioCap).toBeLessThan(desktop.pixelRatioCap);
    expect(mobile.rainCount).toBeLessThan(desktop.rainCount);
    expect(mobile.rainCount).toBeGreaterThan(0);
  });

  it("reducedMotion ⇒ rainCount 0 (overrides), on desktop and mobile", () => {
    expect(
      qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: true }).rainCount,
    ).toBe(0);
    expect(
      qualityFor({ coarsePointer: true, maxDevicePixelRatio: 2, reducedMotion: true }).rainCount,
    ).toBe(0);
  });

  it("always finite; pixelRatioCap ∈ [1,2]; rainCount ≥ 0 across the domain", () => {
    for (const coarsePointer of [true, false]) {
      for (const reducedMotion of [true, false]) {
        for (const maxDevicePixelRatio of [0, 0.5, 1, 1.25, 1.5, 2, 3, 4, NaN, Infinity]) {
          const q = qualityFor({ coarsePointer, maxDevicePixelRatio, reducedMotion });
          expect(Number.isFinite(q.pixelRatioCap)).toBe(true);
          expect(Number.isFinite(q.rainCount)).toBe(true);
          expect(q.pixelRatioCap).toBeGreaterThanOrEqual(1);
          expect(q.pixelRatioCap).toBeLessThanOrEqual(2);
          expect(q.rainCount).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ── O13: tier ordering (desktop ≥ coarse; shadow/bloom; reduced overrides) ────
describe("O13: qualityFor tier ordering invariants", () => {
  const desktop = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false });
  const coarse = qualityFor({ coarsePointer: true, maxDevicePixelRatio: 2, reducedMotion: false });

  it("desktop ribbonHalfWidth ≥ coarse ribbonHalfWidth", () => {
    expect(desktop.ribbonHalfWidth).toBeGreaterThanOrEqual(coarse.ribbonHalfWidth);
  });

  it("desktop terrainSubdiv ≥ coarse terrainSubdiv", () => {
    expect(desktop.terrainSubdiv).toBeGreaterThanOrEqual(coarse.terrainSubdiv);
  });

  it("desktop shadows/bloom true while coarse shadows/bloom false", () => {
    expect(desktop.shadowsEnabled).toBe(true);
    expect(desktop.bloomEnabled).toBe(true);
    expect(coarse.shadowsEnabled).toBe(false);
    expect(coarse.bloomEnabled).toBe(false);
  });

  it("reducedMotion ⇒ attitudeScale 0 and rainCount 0 on every base tier", () => {
    for (const coarsePointer of [true, false]) {
      const q = qualityFor({ coarsePointer, maxDevicePixelRatio: 2, reducedMotion: true });
      expect(q.attitudeScale).toBe(0);
      expect(q.rainCount).toBe(0);
    }
  });

  it("reducedMotion keeps other base-tier fields (desktop ribbon/segLen/subdiv unchanged)", () => {
    const base = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false });
    const reduced = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: true });
    expect(reduced.ribbonHalfWidth).toBe(base.ribbonHalfWidth);
    expect(reduced.terrainSegLen).toBe(base.terrainSegLen);
    expect(reduced.terrainSubdiv).toBe(base.terrainSubdiv);
    expect(reduced.shadowsEnabled).toBe(base.shadowsEnabled);
    expect(reduced.bloomEnabled).toBe(base.bloomEnabled);
    expect(reduced.pixelRatioCap).toBe(base.pixelRatioCap);
  });
});

// ── O14: lodForDistance — exact step at 120 and 350, tier-independent ─────────
describe("O14: lodForDistance exact LOD step boundaries", () => {
  it("step at LOD1_DIST=120: 119⇒0, 120⇒1", () => {
    expect(lodForDistance(119)).toBe(0);
    expect(lodForDistance(119.999)).toBe(0);
    expect(lodForDistance(120)).toBe(1);
  });

  it("step at LOD2_DIST=350: 349⇒1, 350⇒2", () => {
    expect(lodForDistance(349)).toBe(1);
    expect(lodForDistance(349.999)).toBe(1);
    expect(lodForDistance(350)).toBe(2);
  });

  it("ranges: near⇒0, mid⇒1, far⇒2", () => {
    expect(lodForDistance(0)).toBe(0);
    expect(lodForDistance(60)).toBe(0);
    expect(lodForDistance(200)).toBe(1);
    expect(lodForDistance(1000)).toBe(2);
    expect(lodForDistance(Infinity)).toBe(2);
  });

  it("is tier-independent (a free function, not parameterised by tier)", () => {
    // The exported signature takes only a distance — same value regardless of tier.
    expect(lodForDistance(200)).toBe(1);
    expect(lodForDistance(200)).toBe(1);
  });
});

// ── O15: quality domain sweep — all fields finite/correct type ────────────────
describe("O15: qualityFor domain sweep — well-typed across all combinations", () => {
  it("every field has the correct type and finite value over the env grid", () => {
    for (const coarsePointer of [true, false]) {
      for (const reducedMotion of [true, false]) {
        for (const maxDevicePixelRatio of [0, 1, 1.5, 2, 3, NaN, Infinity]) {
          const q: QualitySettings = qualityFor({
            coarsePointer,
            maxDevicePixelRatio,
            reducedMotion,
          });
          expect(Number.isFinite(q.pixelRatioCap)).toBe(true);
          expect(Number.isFinite(q.rainCount)).toBe(true);
          expect(Number.isFinite(q.ribbonHalfWidth)).toBe(true);
          expect(Number.isFinite(q.terrainSegLen)).toBe(true);
          expect(Number.isFinite(q.terrainSubdiv)).toBe(true);
          expect(Number.isFinite(q.attitudeScale)).toBe(true);
          expect(typeof q.shadowsEnabled).toBe("boolean");
          expect(typeof q.bloomEnabled).toBe("boolean");
          expect(q.ribbonHalfWidth).toBeGreaterThan(0);
          expect(q.terrainSegLen).toBeGreaterThan(0);
          expect(q.terrainSubdiv).toBeGreaterThan(0);
          expect(q.attitudeScale).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ── O18: ribbonVertexCount — budgets + exact formula ─────────────────────────
describe("O18: ribbonVertexCount numeric budget + exact formula", () => {
  const KINGSGATE_SEAHAVEN_LENGTH = 14000;
  const desktop = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false });
  const coarse = qualityFor({ coarsePointer: true, maxDevicePixelRatio: 2, reducedMotion: false });

  it("desktop count for the grand route ≤ HIGH_BUDGET", () => {
    const n = ribbonVertexCount(desktop, KINGSGATE_SEAHAVEN_LENGTH);
    expect(n).toBeLessThanOrEqual(HIGH_BUDGET);
    expect(HIGH_BUDGET).toBe(80000);
  });

  it("coarse count for the grand route ≤ LOW_BUDGET", () => {
    const n = ribbonVertexCount(coarse, KINGSGATE_SEAHAVEN_LENGTH);
    expect(n).toBeLessThanOrEqual(LOW_BUDGET);
    expect(LOW_BUDGET).toBe(25000);
  });

  it("exact formula on a hand example: len=14000 desktop ⇒ ceil(14000/8+1)·25 = 43775", () => {
    // ceil(1750 + 1) = 1751; 1751 · (24+1) = 1751 · 25 = 43775
    expect(ribbonVertexCount(desktop, 14000)).toBe(43775);
  });

  it("exact formula on a hand example: len=14000 coarse ⇒ ceil(14000/20+1)·11 = 7711", () => {
    // ceil(700 + 1) = 701; 701 · (10+1) = 701 · 11 = 7711
    expect(ribbonVertexCount(coarse, 14000)).toBe(7711);
  });

  it("matches ceil(len/terrainSegLen + 1)·(terrainSubdiv + 1) across a sweep", () => {
    for (const tier of [desktop, coarse]) {
      for (const len of [0, 100, 901, 14000, 13999.5]) {
        const expected = Math.ceil(len / tier.terrainSegLen + 1) * (tier.terrainSubdiv + 1);
        expect(ribbonVertexCount(tier, len)).toBe(expected);
      }
    }
  });
});
