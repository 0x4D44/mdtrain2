import { describe, it, expect } from "vitest";
import type { Route } from "../src/sim/route";
import { KINGSGATE_SEAHAVEN } from "../src/sim/route";
import { heightAt, planarPoseAt } from "../src/sim/centerline";
import {
  formationHeight,
  macroGround,
  naturalGround,
  terrainHeight,
  macroReliefAt,
  bandMembership,
  viaductSpanAt,
  tunnelBoreAt,
  boreCorridorAt,
  anchorY,
  clampEye,
} from "../src/sim/terrain";

// ── pinned constants (HLD §2.2) ──────────────────────────────────────────────
const SHOULDER = 4;
const BLEND_W = 80;
const BALLAST_DROP = -0.4;
const VIADUCT_THRESH = 18;
const TUNNEL_THRESH = 12;
const SHOULDER_RAMP = 120;
const BORE_HALF = 6;
const NOISE_MAX = 6;
const MIN_EYE_CLEARANCE = 0.5;
const RIBBON_OVERHANG = 200;
/** Lateral distance beyond which the tunnel bore carve has fully faded (so deep
 *  in a tunnel band terrainHeight === naturalGround, the visible hill). */
const BORE_CLEAR = BORE_HALF + BLEND_W;

const ROUTE = KINGSGATE_SEAHAVEN;
const VIADUCT = ROUTE.viaducts?.[0];
const TUNNEL = ROUTE.tunnels?.[0];

if (!VIADUCT || !TUNNEL) {
  throw new Error("test fixture KINGSGATE_SEAHAVEN must carry one viaduct & one tunnel");
}

// A reseeded clone of the grand route (macro fields identical; noise differs).
function reseed(route: Route, seed: number): Route {
  return { ...route, terrainSeed: seed };
}
const ROUTE_B = reseed(ROUTE, 99);

/** Sampled lateral offsets spanning bed, blend and natural ground. */
const D_SAMPLES = [-160, -90, -40, -SHOULDER, -2, 0, 2, SHOULDER, 40, 90, 160];

/** Band edges (where macroRelief crosses the threshold) for O8-edge & O9. */
const VIADUCT_CENTER = VIADUCT.center;
const VIADUCT_HALF = VIADUCT.halfLen;
const TUNNEL_CENTER = TUNNEL.center;
const TUNNEL_HALF = TUNNEL.halfLen;

describe("O7 — anchorY", () => {
  it("anchorY − terrainHeight === clearance and anchorY ≥ terrainHeight", () => {
    for (let s = 0; s <= ROUTE.length; s += 311) {
      for (const d of D_SAMPLES) {
        for (const clearance of [0, 0.5, 3.2]) {
          const t = terrainHeight(ROUTE, s, d);
          const a = anchorY(ROUTE, s, d, clearance);
          expect(a - t).toBeCloseTo(clearance, 9);
          expect(a).toBeGreaterThanOrEqual(t);
        }
      }
    }
  });
});

describe("AC-11 — stations & signals sit on the ballast bed (no 0.4 m float)", () => {
  // The platform edge (~0.7 m off the rail) out to the signal post (~2.9 m) all lie
  // within SHOULDER (4 m), so terrainHeight is the near-track BED = formation − 0.4.
  // The render anchors these structures to terrainHeight (not formationHeight), so
  // they meet the bed; a base pinned to formationHeight would float 0.4 m. None of
  // the station/signal chainages lie in a viaduct/tunnel band (m=0), so it is exact.
  const STRUCTURE_OFFSETS = [0.7, 1.4, 2.2, 2.9];
  it("terrainHeight at each station's near-track offset == formation − 0.4 (and < formation ⇒ a formation-anchored base floats)", () => {
    for (const st of ROUTE.stations) {
      const f = formationHeight(ROUTE, st.chainage);
      for (const d of STRUCTURE_OFFSETS) {
        expect(terrainHeight(ROUTE, st.chainage, d)).toBeCloseTo(f + BALLAST_DROP, 9);
        expect(terrainHeight(ROUTE, st.chainage, d)).toBeLessThan(f);
      }
    }
  });
  it("terrainHeight at each signal's near-track offset == formation − 0.4", () => {
    for (const sig of ROUTE.signals) {
      const f = formationHeight(ROUTE, sig.chainage);
      for (const d of STRUCTURE_OFFSETS) {
        expect(terrainHeight(ROUTE, sig.chainage, d)).toBeCloseTo(f + BALLAST_DROP, 9);
      }
    }
  });
});

describe("O8 — continuous two-surface ground", () => {
  it("m=0 (normal span) ⇒ |d|≤SHOULDER ⇒ terrainHeight == formation + BALLAST_DROP (incl. on curves)", () => {
    // sample s on normal spans (well outside both bands), including the Wealdham
    // curve (κ=1/800 around s≈5000-7000) and the Brinemouth curve (κ=1/500).
    const normalS = [300, 1500, 3000, 5000, 6200, 6800, 9300, 9800, 10300, 13500];
    for (const s of normalS) {
      expect(bandMembership(ROUTE, s)).toBe(0); // m=0 precisely off-band
      const f = formationHeight(ROUTE, s);
      for (const d of [-SHOULDER, -2, 0, 2, SHOULDER]) {
        expect(terrainHeight(ROUTE, s, d)).toBeCloseTo(f + BALLAST_DROP, 9);
      }
    }
  });

  it("m=1 (deep in a band) ⇒ terrainHeight === naturalGround (NON-VACUITY: ∃ s per band with m===1)", () => {
    // Viaduct interior: the valley descends BELOW formation, no bore carve, so
    // the near-track ground follows the natural valley at EVERY d (incl. d=0).
    let viaductHit = false;
    for (let s = VIADUCT_CENTER - VIADUCT_HALF; s <= VIADUCT_CENTER + VIADUCT_HALF; s += 17) {
      if (bandMembership(ROUTE, s) === 1) {
        viaductHit = true;
        for (const d of D_SAMPLES) {
          expect(terrainHeight(ROUTE, s, d)).toBe(naturalGround(ROUTE, s, d));
        }
      }
    }
    expect(viaductHit).toBe(true);

    // Tunnel interior: the hill rises ABOVE formation. Away from the carved bore
    // corridor (|d| ≥ BORE_HALF+BLEND_W) terrainHeight === naturalGround (the
    // visible hill). Inside the bore the ground is carved back to the bed (O8b),
    // so the equality holds only beyond the bore. NON-VACUITY: ∃ s with m===1.
    let tunnelHit = false;
    for (let s = TUNNEL_CENTER - TUNNEL_HALF; s <= TUNNEL_CENTER + TUNNEL_HALF; s += 17) {
      if (bandMembership(ROUTE, s) === 1) {
        tunnelHit = true;
        for (const d of D_SAMPLES) {
          if (Math.abs(d) >= BORE_CLEAR) {
            expect(terrainHeight(ROUTE, s, d)).toBe(naturalGround(ROUTE, s, d));
          }
        }
      }
    }
    expect(tunnelHit).toBe(true);
  });

  it("the tunnel bore is carved: deep in a tunnel band, |d|≤SHOULDER ⇒ terrainHeight == formation + BALLAST_DROP", () => {
    // The near-track corridor through the hill stays on the bed (the bore floor),
    // so the rail runs through a bore, not under a mountain (O8b's mechanism).
    let hit = false;
    for (let s = TUNNEL_CENTER - TUNNEL_HALF; s <= TUNNEL_CENTER + TUNNEL_HALF; s += 17) {
      if (bandMembership(ROUTE, s) === 1) {
        hit = true;
        const f = formationHeight(ROUTE, s);
        for (const d of [-SHOULDER, -2, 0, 2, SHOULDER]) {
          expect(terrainHeight(ROUTE, s, d)).toBeCloseTo(f + BALLAST_DROP, 9);
        }
      }
    }
    expect(hit).toBe(true);
  });

  it("O8-edge: |terrainHeight(s−ε,d) − terrainHeight(s+ε,d)| ≤ NOISE_MAX across every band edge for all d", () => {
    const eps = 0.5;
    const edges = [
      VIADUCT_CENTER - VIADUCT_HALF,
      VIADUCT_CENTER + VIADUCT_HALF,
      VIADUCT_CENTER - VIADUCT_HALF - SHOULDER_RAMP,
      VIADUCT_CENTER + VIADUCT_HALF + SHOULDER_RAMP,
      TUNNEL_CENTER - TUNNEL_HALF,
      TUNNEL_CENTER + TUNNEL_HALF,
      TUNNEL_CENTER - TUNNEL_HALF - SHOULDER_RAMP,
      TUNNEL_CENTER + TUNNEL_HALF + SHOULDER_RAMP,
    ];
    for (const edge of edges) {
      for (const d of D_SAMPLES) {
        const lhs = terrainHeight(ROUTE, edge - eps, d);
        const rhs = terrainHeight(ROUTE, edge + eps, d);
        expect(Math.abs(lhs - rhs)).toBeLessThanOrEqual(NOISE_MAX + 1e-9);
      }
    }
  });

  it("O8-edge (dense): terrainHeight has NO cliff anywhere across either whole band (Δs=1 ⇒ Δh ≤ NOISE_MAX)", () => {
    // Sweep finely across both bands incl. ramps and the bore corridor d's: a
    // 1 m step must never move the ground by more than the noise bound — proves
    // the m(s) blend AND the bore carve are genuinely C0 (no boolean cliff).
    const spans: Array<[number, number]> = [
      [VIADUCT_CENTER - VIADUCT_HALF - SHOULDER_RAMP - 20, VIADUCT_CENTER + VIADUCT_HALF + SHOULDER_RAMP + 20],
      [TUNNEL_CENTER - TUNNEL_HALF - SHOULDER_RAMP - 20, TUNNEL_CENTER + TUNNEL_HALF + SHOULDER_RAMP + 20],
    ];
    for (const [lo, hi] of spans) {
      for (let s = lo; s < hi; s += 1) {
        for (const d of [0, 3, BORE_HALF, 30, 90]) {
          const a = terrainHeight(ROUTE, s, d);
          const b = terrainHeight(ROUTE, s + 1, d);
          expect(Math.abs(a - b)).toBeLessThanOrEqual(NOISE_MAX + 1e-9);
        }
      }
    }
  });

  it("bandMembership ∈ [0,1], monotone 0→1 over the ramp, bit-identical for two terrainSeed (macro-only)", () => {
    // range
    for (let s = 0; s <= ROUTE.length; s += 53) {
      const m = bandMembership(ROUTE, s);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    // monotone non-decreasing across the rising edge of the viaduct band:
    // from (edge − ramp − margin) [m=0] up to the flat interior [m=1].
    const start = VIADUCT_CENTER - VIADUCT_HALF - SHOULDER_RAMP - 10;
    const stop = VIADUCT_CENTER - VIADUCT_HALF + 10;
    let prev = -Infinity;
    for (let s = start; s <= stop; s += 1) {
      const m = bandMembership(ROUTE, s);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = m;
    }
    expect(bandMembership(ROUTE, start)).toBe(0);
    expect(bandMembership(ROUTE, VIADUCT_CENTER)).toBe(1);

    // macro-only: identical for a different seed everywhere.
    for (let s = 0; s <= ROUTE.length; s += 41) {
      expect(bandMembership(ROUTE_B, s)).toBe(bandMembership(ROUTE, s));
    }
  });
});

describe("O8b — track sits on its bed (no clip)", () => {
  it("formationHeight(s) ≥ terrainHeight(s,d) − ε for all |d|≤SHOULDER (incl. bands & ramps)", () => {
    for (let s = 0; s <= ROUTE.length; s += 19) {
      const f = formationHeight(ROUTE, s);
      for (const d of [-SHOULDER, -3, -1, 0, 1, 3, SHOULDER]) {
        expect(f).toBeGreaterThanOrEqual(terrainHeight(ROUTE, s, d) - 1e-9);
      }
    }
  });
});

describe("O8c — viaduct pier feet land on the valley floor (well below the deck)", () => {
  it("at each pier (s, ±PIER_OFFSET) the ground is the natural valley, far below formationHeight", () => {
    // The render drops each pier foot to terrainHeight(route, sPier, dPier) at the
    // pier-row offset ±PIER_OFFSET (terrain-mesh.ts). The property that makes the
    // piers genuinely "reach the valley floor": on a viaduct there is NO bore carve,
    // so that ground is the natural valley AND sits well below the deck. (A self-
    // comparison terrainHeight===terrainHeight would pin nothing.)
    const PIER_OFFSET = 2.2; // matches terrain-mesh.ts pier-row lateral offset
    let sampled = 0;
    for (let s = VIADUCT_CENTER - VIADUCT_HALF; s <= VIADUCT_CENTER + VIADUCT_HALF; s += 80) {
      if (bandMembership(ROUTE, s) !== 1) continue; // deep in the band: full valley, no carve
      const deck = formationHeight(ROUTE, s); // the deck the train always runs on
      for (const d of [-PIER_OFFSET, PIER_OFFSET]) {
        const floor = terrainHeight(ROUTE, s, d);
        expect(floor).toBeCloseTo(naturalGround(ROUTE, s, d), 9); // the natural valley ground
        expect(floor).toBeLessThan(deck - VIADUCT_THRESH); // a genuine drop, not the rail bed
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(0); // non-vacuous: real piers were evaluated
  });
});

describe("O9 — macro predicates + bounded noise", () => {
  it("macroReliefAt ≈ ±depth flat inside each band; |relief| < THRESH at ≥120 m outside", () => {
    // viaduct: relief ≈ −valleyDepth across the flat interior
    for (let s = VIADUCT_CENTER - VIADUCT_HALF + 1; s < VIADUCT_CENTER + VIADUCT_HALF; s += 31) {
      expect(macroReliefAt(ROUTE, s)).toBeCloseTo(-VIADUCT.valleyDepth, 9);
    }
    // tunnel: relief ≈ +hillHeight across the flat interior
    for (let s = TUNNEL_CENTER - TUNNEL_HALF + 1; s < TUNNEL_CENTER + TUNNEL_HALF; s += 31) {
      expect(macroReliefAt(ROUTE, s)).toBeCloseTo(TUNNEL.hillHeight, 9);
    }
    // ≥120 m outside each band edge ⇒ relief is back to 0 (|relief| < THRESH)
    const outside = [
      VIADUCT_CENTER - VIADUCT_HALF - SHOULDER_RAMP - 1,
      VIADUCT_CENTER + VIADUCT_HALF + SHOULDER_RAMP + 1,
      TUNNEL_CENTER - TUNNEL_HALF - SHOULDER_RAMP - 1,
      TUNNEL_CENTER + TUNNEL_HALF + SHOULDER_RAMP + 1,
    ];
    for (const s of outside) {
      expect(Math.abs(macroReliefAt(ROUTE, s))).toBeLessThan(VIADUCT_THRESH);
      expect(Math.abs(macroReliefAt(ROUTE, s))).toBeLessThan(TUNNEL_THRESH);
    }
  });

  it("predicates true on the band, false ≥120 m outside", () => {
    // on the viaduct flat interior
    expect(viaductSpanAt(ROUTE, VIADUCT_CENTER)).toBe(true);
    expect(tunnelBoreAt(ROUTE, VIADUCT_CENTER)).toBe(false);
    // on the tunnel flat interior
    expect(tunnelBoreAt(ROUTE, TUNNEL_CENTER)).toBe(true);
    expect(viaductSpanAt(ROUTE, TUNNEL_CENTER)).toBe(false);
    // ≥120 m outside each edge ⇒ both predicates false
    const outside = [
      VIADUCT_CENTER - VIADUCT_HALF - SHOULDER_RAMP - 1,
      VIADUCT_CENTER + VIADUCT_HALF + SHOULDER_RAMP + 1,
      TUNNEL_CENTER - TUNNEL_HALF - SHOULDER_RAMP - 1,
      TUNNEL_CENTER + TUNNEL_HALF + SHOULDER_RAMP + 1,
    ];
    for (const s of outside) {
      expect(viaductSpanAt(ROUTE, s)).toBe(false);
      expect(tunnelBoreAt(ROUTE, s)).toBe(false);
    }
  });

  it("|valueNoise| ≤ NOISE_MAX < THRESH so noise never flips a predicate", () => {
    // valueNoise = naturalGround − macroGround
    for (let s = 0; s <= ROUTE.length; s += 23) {
      for (const d of D_SAMPLES) {
        const noise = naturalGround(ROUTE, s, d) - macroGround(ROUTE, s, d);
        expect(Math.abs(noise)).toBeLessThanOrEqual(NOISE_MAX + 1e-9);
      }
    }
    expect(NOISE_MAX).toBeLessThan(VIADUCT_THRESH);
    expect(NOISE_MAX).toBeLessThan(TUNNEL_THRESH);
  });

  it("predicates never both true; boreCorridorAt ⇒ tunnelBoreAt", () => {
    for (let s = 0; s <= ROUTE.length; s += 13) {
      expect(viaductSpanAt(ROUTE, s) && tunnelBoreAt(ROUTE, s)).toBe(false);
      for (const d of [-10, -BORE_HALF, -3, 0, 3, BORE_HALF, 10]) {
        if (boreCorridorAt(ROUTE, s, d)) {
          expect(tunnelBoreAt(ROUTE, s)).toBe(true);
        }
      }
    }
    // boreCorridor holds inside the bore for |d| < BORE_HALF and not beyond
    expect(boreCorridorAt(ROUTE, TUNNEL_CENTER, 0)).toBe(true);
    expect(boreCorridorAt(ROUTE, TUNNEL_CENTER, BORE_HALF + 0.1)).toBe(false);
    expect(boreCorridorAt(ROUTE, VIADUCT_CENTER, 0)).toBe(false);
  });

  it("terrainHeight bit-identical on repeat; terrainSeed change alters the ground but NOT any predicate", () => {
    for (let s = 0; s <= ROUTE.length; s += 29) {
      for (const d of D_SAMPLES) {
        expect(terrainHeight(ROUTE, s, d)).toBe(terrainHeight(ROUTE, s, d));
      }
      // predicates seed-invariant
      expect(viaductSpanAt(ROUTE_B, s)).toBe(viaductSpanAt(ROUTE, s));
      expect(tunnelBoreAt(ROUTE_B, s)).toBe(tunnelBoreAt(ROUTE, s));
    }
    // the noise/ground actually differs somewhere for the two seeds
    let differs = false;
    for (let s = 0; s <= ROUTE.length && !differs; s += 7) {
      for (const d of D_SAMPLES) {
        if (naturalGround(ROUTE_B, s, d) !== naturalGround(ROUTE, s, d)) {
          differs = true;
          break;
        }
      }
    }
    expect(differs).toBe(true);
  });
});

describe("O20 — clampEye floors the eye at terrainHeight(s,eyeD)+0.5", () => {
  it("raises an eye below the floor, leaves a high eye alone", () => {
    const eyeD = -0.5;
    for (let s = 0; s <= ROUTE.length; s += 271) {
      const floor = terrainHeight(ROUTE, s, eyeD) + MIN_EYE_CLEARANCE;
      // an eye buried below the floor is lifted exactly to the floor
      expect(clampEye(ROUTE, s, eyeD, floor - 100)).toBeCloseTo(floor, 9);
      // an eye already above the floor is untouched
      expect(clampEye(ROUTE, s, eyeD, floor + 50)).toBe(floor + 50);
      // result is always ≥ the floor
      expect(clampEye(ROUTE, s, eyeD, floor - 5)).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });
});

describe("O-DOMAIN — ribbon s-domain continuity across s=0 and s=length", () => {
  it("heightAt/planarPoseAt/terrainHeight continuous across s=0 (extrapolating into [−OVERHANG,0])", () => {
    const eps = 0.5;
    for (const s0 of [0, ROUTE.length]) {
      const hL = heightAt(ROUTE, s0 - eps);
      const hR = heightAt(ROUTE, s0 + eps);
      expect(Math.abs(hL - hR)).toBeLessThan(0.1);

      // JUMP test (not a displacement bound): the spine advances ≈ 2·eps along the
      // local heading over the 2·eps span; subtract that expected advance and require
      // the residual ≈ 0. This detects a real discontinuity REGARDLESS of endpoint
      // curvature (a loose displacement bound could hide a sub-metre jump on a curve).
      const pL = planarPoseAt(ROUTE, s0 - eps);
      const pR = planarPoseAt(ROUTE, s0 + eps);
      const mid = planarPoseAt(ROUTE, s0);
      const fwdX = Math.sin(mid.heading); // tangent = (sinψ, cosψ) in (x,z)
      const fwdZ = Math.cos(mid.heading);
      expect(Math.abs((pR.x - pL.x) - 2 * eps * fwdX)).toBeLessThan(1e-3);
      expect(Math.abs((pR.z - pL.z) - 2 * eps * fwdZ)).toBeLessThan(1e-3);
      expect(Math.abs(pL.heading - pR.heading)).toBeLessThan(0.05);

      for (const d of [-0.5, 0, 0.5]) {
        const tL = terrainHeight(ROUTE, s0 - eps, d);
        const tR = terrainHeight(ROUTE, s0 + eps, d);
        expect(Math.abs(tL - tR)).toBeLessThanOrEqual(NOISE_MAX + 0.1);
      }
    }
  });

  it("the pure functions evaluate (finite) across the whole overhang domain", () => {
    for (let s = -RIBBON_OVERHANG; s <= ROUTE.length + RIBBON_OVERHANG; s += 50) {
      for (const d of [-0.5, 0, 0.5]) {
        expect(Number.isFinite(terrainHeight(ROUTE, s, d))).toBe(true);
        expect(Number.isFinite(formationHeight(ROUTE, s))).toBe(true);
        expect(Number.isFinite(macroGround(ROUTE, s, d))).toBe(true);
        expect(Number.isFinite(naturalGround(ROUTE, s, d))).toBe(true);
      }
    }
  });
});
