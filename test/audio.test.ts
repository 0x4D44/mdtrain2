import { describe, it, expect } from "vitest";
import { audioParams } from "../src/audio/params";

describe("AUD1: whineHz strictly increases with speed", () => {
  it("0 < 10 < 25 m/s", () => {
    const a = audioParams(0, 0, 0).whineHz;
    const b = audioParams(10, 0, 0).whineHz;
    const c = audioParams(25, 0, 0).whineHz;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe("AUD2: tractionGain increases with notch", () => {
  it("notch 0 ⇒ ~0; notch 1 ⇒ greater", () => {
    const off = audioParams(20, 0, 0).tractionGain;
    const half = audioParams(20, 0.5, 0).tractionGain;
    const full = audioParams(20, 1, 0).tractionGain;
    expect(off).toBeLessThan(1e-6);
    expect(half).toBeGreaterThan(off);
    expect(full).toBeGreaterThan(half);
  });
});

describe("AUD3: rollGain increases with |speed| and is ≈0 at rest", () => {
  it("rises with speed; silent at rest", () => {
    const rest = audioParams(0, 0, 0).rollGain;
    const slow = audioParams(10, 0, 0).rollGain;
    const fast = audioParams(25, 0, 0).rollGain;
    expect(rest).toBeLessThan(1e-6);
    expect(slow).toBeGreaterThan(rest);
    expect(fast).toBeGreaterThan(slow);
  });
});

describe("AUD4: brakeHissGain tracks brake", () => {
  it("brake 0 ⇒ 0; brake 1 ⇒ > 0", () => {
    expect(audioParams(20, 0, 0).brakeHissGain).toBeLessThan(1e-6);
    expect(audioParams(20, 0, 1).brakeHissGain).toBeGreaterThan(0);
  });
});

describe("AUD5: silence at rest and finite outputs across the domain", () => {
  it("all gains < epsilon at speed 0 / notch 0 / brake 0", () => {
    const p = audioParams(0, 0, 0);
    const eps = 1e-6;
    expect(p.tractionGain).toBeLessThan(eps);
    expect(p.rollGain).toBeLessThan(eps);
    expect(p.brakeHissGain).toBeLessThan(eps);
  });

  it("sweep yields only finite, in-range values", () => {
    for (let speed = 0; speed <= 50; speed += 5) {
      for (const notch of [0, 0.5, 1]) {
        for (const brake of [0, 1]) {
          // include negative speed (direction must not matter)
          for (const v of [speed, -speed]) {
            const p = audioParams(v, notch, brake);
            for (const g of [p.tractionGain, p.rollGain, p.brakeHissGain]) {
              expect(Number.isFinite(g)).toBe(true);
              expect(g).toBeGreaterThanOrEqual(0);
              expect(g).toBeLessThanOrEqual(1);
            }
            expect(Number.isFinite(p.whineHz)).toBe(true);
            expect(p.whineHz).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
