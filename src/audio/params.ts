// Pure sim-state → audio-parameter mapping for the GTO-inverter EMU.
//
// This is the one tested seam of the Phase 3 audio path (HLD §2.4). It is a
// pure math mapping: no Date, no Math.random, no timers, no I/O. The WebAudio
// graph (src/audio/engine.ts) is a thin impure adapter that consumes these.

/** Audio parameters derived from sim state, all finite, gains in [0, 1]. */
export interface AudioParams {
  /** GTO inverter "gearbox" whine tone, Hz — rises with |speed|. */
  whineHz: number;
  /** 0..1 whine audibility, driven by power notch. */
  tractionGain: number;
  /** 0..1 rolling/rail noise, rises with |speed|, ≈0 at rest. */
  rollGain: number;
  /** 0..1 brake hiss, follows brake demand (and mildly |speed|). */
  brakeHissGain: number;
}

/** Reference line speed for normalising speed → fractions (~100 mph). */
const LINE_SPEED_MPS = 44.7;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Make a value finite; map NaN/±Infinity to a safe fallback. */
const finite = (x: number, fallback = 0): number =>
  Number.isFinite(x) ? x : fallback;

/**
 * Map sim state to procedural-audio parameters (HLD §2.4).
 *
 * - `whineHz` increases strictly with |speed|: a low ~60 Hz base rising to a
 *   few hundred Hz at line speed. A smooth monotonic rise (simplest that
 *   satisfies AUD1 across 0 < 10 < 25 m/s).
 * - `tractionGain` tracks `notch` (0 at notch 0, full at notch 1).
 * - `rollGain` rises with |speed|, ≈0 at rest.
 * - `brakeHissGain` tracks `brake`, scaled mildly by |speed|.
 *
 * All outputs are finite; gains are clamped to [0, 1]. Negative speed is
 * treated by magnitude (direction is irrelevant to the sound).
 */
export function audioParams(
  speedMps: number,
  notch: number,
  brake: number,
): AudioParams {
  const speed = Math.abs(finite(speedMps));
  // Normalised speed fraction (0 at rest, 1 at line speed). Allow >1 above
  // line speed so whineHz keeps rising, but cap gains separately.
  const speedFrac = speed / LINE_SPEED_MPS;

  // Whine: 60 Hz base + 300 Hz of rise across the speed range. Strictly
  // increasing in |speed| (linear term guarantees monotonicity); the sqrt
  // term front-loads the rise for a more believable, eager spool-up while
  // staying monotonic.
  const whineHz = finite(
    60 + 220 * speedFrac + 90 * Math.sqrt(Math.max(speedFrac, 0)),
    60,
  );

  // Traction: the whine is audible under power. Linear in notch, clamped.
  const tractionGain = clamp01(finite(notch));

  // Rolling/rail noise: rises with |speed|, exactly 0 at rest.
  const rollGain = clamp01(finite(Math.min(speedFrac, 1)));

  // Brake hiss: present only when braking; a little louder at speed.
  const brakeHissGain = clamp01(
    finite(clamp01(finite(brake)) * (0.5 + 0.5 * Math.min(speedFrac, 1))),
  );

  return { whineHz, tractionGain, rollGain, brakeHissGain };
}
