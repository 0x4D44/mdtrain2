// Performance tier (PURE). Maps device capability to a pixel-ratio cap and a rain
// particle count, so weak/mobile devices draw fewer particles at a capped ratio.
// Defaults to today's values (cap 2, 2400 particles) so desktop is a no-regression.

export interface QualitySettings {
  pixelRatioCap: number; // clamp on devicePixelRatio when sizing the renderer
  rainCount: number; // number of rain particles the scene allocates
}

interface QualityEnv {
  coarsePointer: boolean; // matchMedia('(pointer: coarse)') — mobile/touch
  maxDevicePixelRatio: number; // window.devicePixelRatio
  reducedMotion: boolean; // prefers-reduced-motion: reduce
}

const DESKTOP_RAIN = 2400; // today's hard-coded count
const MOBILE_RAIN = 900; // fewer particles on weak GPUs

/** Clamp `n` into [lo, hi]; non-finite inputs fall back to `lo`. */
function clampRatio(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Desktop (not coarse, not reduced) ⇒ { pixelRatioCap: 2, rainCount: 2400 }.
 * Coarse-pointer ⇒ lower cap (≤ 1.5) and ~900 particles.
 * reducedMotion ⇒ rainCount 0 (overrides everything else).
 * Always finite; `pixelRatioCap ∈ [1, 2]`; `rainCount ≥ 0`.
 */
export function qualityFor(env: QualityEnv): QualitySettings {
  const pixelRatioCap = env.coarsePointer
    ? clampRatio(env.maxDevicePixelRatio, 1, 1.5)
    : clampRatio(env.maxDevicePixelRatio, 1, 2);

  let rainCount = env.coarsePointer ? MOBILE_RAIN : DESKTOP_RAIN;
  if (env.reducedMotion) rainCount = 0;

  return { pixelRatioCap, rainCount };
}
