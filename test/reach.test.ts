import { describe, it, expect } from "vitest";
import { motionParams } from "../src/ui/motion";
import { qualityFor } from "../src/render/quality";

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
  it("desktop ⇒ exactly { pixelRatioCap: 2, rainCount: 2400 }", () => {
    expect(
      qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false }),
    ).toEqual({ pixelRatioCap: 2, rainCount: 2400 });
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
