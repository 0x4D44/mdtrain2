// Reduced-motion accessibility params (PURE). The shell reads
// `matchMedia('(prefers-reduced-motion: reduce)')` once and passes the boolean in;
// the rain scale / wiper gate are decided here so the rule is testable.

export interface MotionParams {
  rainScale: number; // multiplies the environment's rainIntensity (0 ⇒ no rain)
  wiperEnabled: boolean; // ANDs with wiperOn (false ⇒ wiper parked)
}

/**
 * `reduce` ⇒ rain cut and wiper parked; otherwise full motion (today's behaviour).
 */
export function motionParams(prefersReducedMotion: boolean): MotionParams {
  return prefersReducedMotion
    ? { rainScale: 0, wiperEnabled: false }
    : { rainScale: 1, wiperEnabled: true };
}
