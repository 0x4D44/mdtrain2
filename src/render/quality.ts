// Performance tier (PURE). Maps device capability to a render-quality profile:
// pixel-ratio cap, rain count, plus the Grand-World fields (shadows, bloom,
// ribbon/terrain LOD parameters, cab-attitude scale). Pure: no Three.js, no DOM,
// no wall-clock, no randomness — see HLD §2.4 for the pinned tier table.
//
// Defaults to today's values (cap 2, 2400 particles) on desktop so it is a
// no-regression; the new fields are added per the pinned tier table.

export interface QualitySettings {
  pixelRatioCap: number; // clamp on devicePixelRatio when sizing the renderer
  rainCount: number; // number of rain particles the scene allocates
  shadowsEnabled: boolean; // eye-tracking directional shadow on/off
  bloomEnabled: boolean; // lazy bloom composer on/off
  ribbonHalfWidth: number; // metres each side of centreline the terrain ribbon spans
  terrainSegLen: number; // along-track length of one terrain ribbon segment (m)
  terrainSubdiv: number; // cross-track subdivisions per ribbon section
  attitudeScale: number; // cab pitch/roll response scale (0 disables attitude)
}

interface QualityEnv {
  coarsePointer: boolean; // matchMedia('(pointer: coarse)') — mobile/touch
  maxDevicePixelRatio: number; // window.devicePixelRatio
  reducedMotion: boolean; // prefers-reduced-motion: reduce
}

const DESKTOP_RAIN = 2400; // today's hard-coded count
const MOBILE_RAIN = 900; // fewer particles on weak GPUs

// LOD distance thresholds (metres) — tier-INDEPENDENT (HLD §2.4).
const LOD1_DIST = 120;
const LOD2_DIST = 350;

// Ground-ribbon vertex budgets (O18, HLD §2.4).
export const HIGH_BUDGET = 80000;
export const LOW_BUDGET = 25000;

/** Clamp `n` into [lo, hi]; non-finite inputs fall back to `lo`. */
function clampRatio(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Desktop (not coarse) ⇒ shadows/bloom on, ribbonHalfWidth 180, terrainSegLen 8,
 * terrainSubdiv 24, attitudeScale 0.35, { pixelRatioCap: 2, rainCount: 2400 }.
 * Coarse-pointer ⇒ shadows/bloom off, ribbonHalfWidth 110, terrainSegLen 20,
 * terrainSubdiv 10, attitudeScale 0, lower cap (≤ 1.5) and ~900 particles.
 * reducedMotion ⇒ rainCount 0 AND attitudeScale 0 (overrides those two only;
 * all other fields keep their base-tier values).
 * Always finite; `pixelRatioCap ∈ [1, 2]`; `rainCount ≥ 0`.
 */
export function qualityFor(env: QualityEnv): QualitySettings {
  const pixelRatioCap = env.coarsePointer
    ? clampRatio(env.maxDevicePixelRatio, 1, 1.5)
    : clampRatio(env.maxDevicePixelRatio, 1, 2);

  const base: QualitySettings = env.coarsePointer
    ? {
        pixelRatioCap,
        rainCount: MOBILE_RAIN,
        shadowsEnabled: false,
        bloomEnabled: false,
        ribbonHalfWidth: 110,
        terrainSegLen: 20,
        terrainSubdiv: 10,
        attitudeScale: 0,
      }
    : {
        pixelRatioCap,
        rainCount: DESKTOP_RAIN,
        shadowsEnabled: true,
        bloomEnabled: true,
        ribbonHalfWidth: 180,
        terrainSegLen: 8,
        terrainSubdiv: 24,
        attitudeScale: 0.35,
      };

  if (env.reducedMotion) {
    base.rainCount = 0;
    base.attitudeScale = 0;
  }

  return base;
}

/**
 * Map a camera-space distance (m) to a discrete level of detail.
 * `distance < LOD1_DIST(120)` ⇒ 0 (full detail); `< LOD2_DIST(350)` ⇒ 1; else 2.
 * Tier-INDEPENDENT: only the distance matters.
 */
export function lodForDistance(distance: number): 0 | 1 | 2 {
  if (distance < LOD1_DIST) return 0;
  if (distance < LOD2_DIST) return 1;
  return 2;
}

/**
 * Ground-ribbon vertex count for a tier over a route of `routeLength` metres.
 * `ceil(routeLength / terrainSegLen + 1) · (terrainSubdiv + 1)` (HLD §2.4, O18).
 */
export function ribbonVertexCount(tier: QualitySettings, routeLength: number): number {
  return Math.ceil(routeLength / tier.terrainSegLen + 1) * (tier.terrainSubdiv + 1);
}
