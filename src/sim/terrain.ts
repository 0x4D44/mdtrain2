// The terrain layer (HLD §2.2): the two-surface living land as a pure function
// of curvilinear coordinates (s, d). There are TWO surfaces:
//
//   formationHeight(s)  — the rail/deck TOP the train ALWAYS runs on (= heightAt)
//   terrainHeight(s,d)  — the GROUND, which coincides with the bed near the track
//                          on normal spans but DIVERGES in viaduct/tunnel bands
//                          (down to the valley floor, up into the hill).
//
// The ground is ONE s-continuous formula (D27): a clean rail bed near the track,
// blended out to the natural cutting/embankment ground over BLEND_W, then blended
// to the full natural valley/hill ground over the macro band membership m(s). No
// boolean branch ⇒ no C0 cliff at band edges (O8-edge).
//
// Macro relief (the authored landform) is thresholded by the predicates; the
// value noise is BOUNDED (|noise| ≤ NOISE_MAX < THRESH) so it can never flip a
// predicate (D24, O9). Everything is integer-hash noise + Math trig: no Three,
// no DOM, no clock, no randomness — G3-clean.

import type { Route } from "./route";
import { heightAt } from "./centerline";

// ── pinned constants (HLD §2.2) ──────────────────────────────────────────────
/** Half-width of the flat ballast shoulder either side of the spine, m. */
const SHOULDER = 4;
/** Lateral distance over which the bed blends to the natural ground, m. */
const BLEND_W = 80;
/** Ground/ballast top offset from the rail/deck top, m. NEGATIVE: the ballast
 *  shoulder sits 0.4 m BELOW the rail top so the rail is proud of the ballast —
 *  this reconciles O8 (terrainHeight = formation + BALLAST_DROP near the track)
 *  with O8b (formationHeight ≥ terrainHeight). */
const BALLAST_DROP = -0.4;
/** |macroRelief| beyond this fires viaductSpanAt (the deep valley), m. */
const VIADUCT_THRESH = 18;
/** |macroRelief| beyond this fires tunnelBoreAt (the high hill), m. */
const TUNNEL_THRESH = 12;
/** Chainage over which a macro plateau ramps 0→depth BEYOND its half-length, m. */
const SHOULDER_RAMP = 120;
/** Half-width of the render-omitted bore corridor inside a tunnel, m. */
const BORE_HALF = 6;
/** Hard bound on the value noise amplitude, m (< both thresholds, with margin). */
const NOISE_MAX = 6;
/** Minimum vertical clearance the eye is floored above the ground, m. */
const MIN_EYE_CLEARANCE = 0.5;
/** Hill rise (m) at which the bore carve saturates: the carve is FULL across the
 *  whole tunnel band (incl. ramps) once the hill clears the bed by this little,
 *  so the bore floor carries the rail everywhere the hill is up (O8b). Small ⇒
 *  the carve only fades at the outer tip where m→0 anyway (no cliff, O8-edge). */
const CARVE_RELIEF = 2;

// ── value-noise lattice constants (pure integer hash; no RNG, no clock) ───────
/** Lattice cell size for the seeded value noise, m. */
const CELL = 24;
/** Default terrain seed when route.terrainSeed is absent. */
const DEFAULT_SEED = 1;
/** Number of fractal octaves. */
const OCTAVES = 3;

// ── small pure helpers ───────────────────────────────────────────────────────

/** Cubic Hermite smoothstep on [a,b]; 0 at/below a, 1 at/above b, monotone. */
function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. */
function lerp(p: number, q: number, t: number): number {
  return p + (q - p) * t;
}

/**
 * A deterministic 32-bit hash → float in [0,1). Mulberry32 finaliser applied to
 * a Cantor-mixed (seed, ix, iy) triple. Pure integer arithmetic (>>>, *, ^), no
 * RNG and no clock — G3-clean.
 */
function hash01(seed: number, ix: number, iy: number): number {
  // Mix the three integers into one 32-bit state.
  let h = (seed | 0) >>> 0;
  h = (h ^ ((ix | 0) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ ((iy | 0) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  // Mulberry32 finaliser.
  h = (h + 0x6d2b79f5) >>> 0;
  let t = h;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  t = (t ^ (t >>> 14)) >>> 0;
  return t / 4294967296;
}

/** floor that works for negative s/d (Math.floor already does; explicit for read). */
function cellIndex(v: number): number {
  return Math.floor(v / CELL);
}

/**
 * Bilinearly-interpolated, fractal (OCTAVES) value noise in [−1,1], seeded by the
 * route's terrainSeed and the integer lattice over (s, d). Pure & deterministic.
 */
function valueNoiseUnit(seed: number, s: number, d: number): number {
  let sum = 0;
  let amp = 1;
  let ampTotal = 0;
  let fs = s;
  let fd = d;
  let octaveSeed = seed >>> 0;
  for (let o = 0; o < OCTAVES; o++) {
    const cx = cellIndex(fs);
    const cy = cellIndex(fd);
    const tx = fs / CELL - cx;
    const ty = fd / CELL - cy;
    const n00 = hash01(octaveSeed, cx, cy);
    const n10 = hash01(octaveSeed, cx + 1, cy);
    const n01 = hash01(octaveSeed, cx, cy + 1);
    const n11 = hash01(octaveSeed, cx + 1, cy + 1);
    const sx = tx * tx * (3 - 2 * tx); // smooth the interpolation weight
    const sy = ty * ty * (3 - 2 * ty);
    const nx0 = lerp(n00, n10, sx);
    const nx1 = lerp(n01, n11, sx);
    const n = lerp(nx0, nx1, sy); // in [0,1]
    sum += (n * 2 - 1) * amp; // map to [−1,1]
    ampTotal += amp;
    amp *= 0.5;
    fs *= 2;
    fd *= 2;
    octaveSeed = (Math.imul(octaveSeed ^ 0x9e3779b9, 0x85ebca6b) >>> 0) >>> 0;
  }
  // Normalise so the fractal sum stays within [−1,1] regardless of OCTAVES.
  return ampTotal === 0 ? 0 : sum / ampTotal;
}

// ── macro landform (no noise) ────────────────────────────────────────────────

/**
 * The signed macro plateau at chainage s: the authored landform relief relative
 * to the formation. Each viaduct band lowers the ground by `valleyDepth` (signed
 * −depth) and each tunnel band raises it by `hillHeight` (signed +height), flat
 * across [center−halfLen, center+halfLen] and ramping (smoothstep) to 0 over
 * SHOULDER_RAMP BEYOND halfLen. Bands do not overlap, so the contributions sum.
 */
function macroPlateau(route: Route, s: number): number {
  let relief = 0;
  if (route.viaducts) {
    for (const v of route.viaducts) {
      relief += -v.valleyDepth * bandShape(s, v.center, v.halfLen);
    }
  }
  if (route.tunnels) {
    for (const t of route.tunnels) {
      relief += t.hillHeight * bandShape(s, t.center, t.halfLen);
    }
  }
  return relief;
}

/**
 * The unit band shape ∈ [0,1]: 1 across [center−halfLen, center+halfLen], a
 * smoothstep ramp to 0 over SHOULDER_RAMP beyond each edge, 0 elsewhere. Monotone
 * on each flank ⇒ |macroRelief| is monotone across each band edge (O8 monotone).
 */
function bandShape(s: number, center: number, halfLen: number): number {
  const dist = Math.abs(s - center);
  if (dist <= halfLen) return 1;
  // beyond the flat interior: ramp 1→0 over SHOULDER_RAMP.
  return 1 - smoothstep(halfLen, halfLen + SHOULDER_RAMP, dist);
}

// ── exported surfaces & predicates ───────────────────────────────────────────

/** The rail/deck TOP the train ALWAYS runs on (= the centreline height). */
export function formationHeight(route: Route, s: number): number {
  return heightAt(route, s);
}

/** The authored macro landform ground (NO noise): formation + macro plateau. */
export function macroGround(route: Route, s: number, _d: number): number {
  return formationHeight(route, s) + macroPlateau(route, s);
}

/** macroGround + bounded seeded value noise (|noise| ≤ NOISE_MAX). */
export function naturalGround(route: Route, s: number, d: number): number {
  const seed = route.terrainSeed ?? DEFAULT_SEED;
  const noise = valueNoiseUnit(seed, s, d) * NOISE_MAX;
  return macroGround(route, s, d) + noise;
}

/** macroGround(s,0) − formation(s) = the macro plateau (NO noise). */
export function macroReliefAt(route: Route, s: number): number {
  return macroGround(route, s, 0) - formationHeight(route, s);
}

/**
 * Band membership m(s) ∈ [0,1] (macro-only): 0 on normal spans, 1 fully inside a
 * viaduct/tunnel band, a smooth (smoothstep) handoff across the edge. Computed
 * per band against that band's own threshold and combined by max (bands do not
 * overlap), so the same SHOULDER_RAMP that shapes the plateau also eases the
 * near-track ground. Reads ONLY macro data ⇒ identical for any terrainSeed.
 */
export function bandMembership(route: Route, s: number): number {
  let m = 0;
  if (route.viaducts) {
    for (const v of route.viaducts) {
      const relief = v.valleyDepth * bandShape(s, v.center, v.halfLen);
      m = Math.max(m, smoothstep(0, VIADUCT_THRESH, relief));
    }
  }
  if (route.tunnels) {
    for (const t of route.tunnels) {
      const relief = t.hillHeight * bandShape(s, t.center, t.halfLen);
      m = Math.max(m, smoothstep(0, TUNNEL_THRESH, relief));
    }
  }
  return m;
}

/** True where the macro ground is a deep valley (a viaduct carries the line). */
export function viaductSpanAt(route: Route, s: number): boolean {
  return macroReliefAt(route, s) < -VIADUCT_THRESH;
}

/** True where the macro ground is a high hill (the line runs through a bore). */
export function tunnelBoreAt(route: Route, s: number): boolean {
  return macroReliefAt(route, s) > TUNNEL_THRESH;
}

/** The render-omitted near-track corridor inside a tunnel: bore ∧ |d| < BORE_HALF. */
export function boreCorridorAt(route: Route, s: number, d: number): boolean {
  return tunnelBoreAt(route, s) && Math.abs(d) < BORE_HALF;
}

// ── the ground surface — one s-continuous formula (D20 + D27) ─────────────────

/**
 * The clean rail-bed offset at lateral |d|: a constant BALLAST_DROP for |d| ≤
 * SHOULDER (the flat ballast shoulder), then ramping to 0 over the shoulder
 * beyond (so the bed meets the natural ground without a step).
 */
function ballastShoulder(absd: number): number {
  if (absd <= SHOULDER) return BALLAST_DROP;
  // ramp BALLAST_DROP → 0 over the shoulder blend so the bed joins the ground.
  return BALLAST_DROP * (1 - smoothstep(SHOULDER, SHOULDER + BLEND_W, absd));
}

/**
 * The macro HILL relief at s (tunnels only, NO valley, NO noise): how far the
 * authored hill rises above the formation, ≥ 0. Used to drive the bore carve so
 * the near-track corridor is pulled back to the bed wherever the hill is up.
 */
function hillReliefAt(route: Route, s: number): number {
  let relief = 0;
  if (route.tunnels) {
    for (const t of route.tunnels) {
      relief += t.hillHeight * bandShape(s, t.center, t.halfLen);
    }
  }
  return relief;
}

/**
 * The tunnel-bore carve weight ∈ [0,1]: 1 inside the bore corridor near the track
 * (|d| ≤ SHOULDER, anywhere the hill is meaningfully up) fading to 0 laterally
 * over the shoulder beyond BORE_HALF and longitudinally as the hill subsides. It
 * pulls the near-track ground back to the BED (the bore floor) instead of letting
 * it rise into the hill — so the track never sinks below the ground (O8b) and the
 * bore is carved. The longitudinal gate `smoothstep(0,CARVE_RELIEF,hillRelief)`
 * SATURATES while the hill is still only CARVE_RELIEF above the bed, so the carve
 * is FULL across the whole band (incl. the ramps) wherever the hill clears the
 * bed; at the outer tip (hillRelief→0) the band membership m→0 too, so the fading
 * carve there is masked (no cliff, O8-edge). ZERO on viaducts / normal spans;
 * smooth & macro-only.
 */
function boreCarve(route: Route, s: number, absd: number): number {
  const hill = hillReliefAt(route, s);
  if (hill === 0) return 0;
  const lateral = 1 - smoothstep(SHOULDER, BORE_HALF + BLEND_W, absd);
  const longitudinal = smoothstep(0, CARVE_RELIEF, hill);
  return lateral * longitudinal;
}

/**
 * THE GROUND (HLD D27): a clean bed near the track, blended to the natural
 * cutting/embankment ground over BLEND_W, then blended to the full natural
 * valley/hill ground over the macro band membership m(s) — one s- AND d-continuous
 * formula, no boolean branch ⇒ no cliff at band edges (O8-edge). Finally, in a
 * tunnel the near-track corridor is carved back toward the bed (boreCarve) so the
 * bore floor carries the rail and the track never sinks (O8b); the visible hill
 * stays beyond the bore. Viaduct bands are untouched (the valley descent is the
 * intended two-surface behaviour).
 */
export function terrainHeight(route: Route, s: number, d: number): number {
  const absd = Math.abs(d);
  const formation = formationHeight(route, s);
  const natural = naturalGround(route, s, d);

  const bed = formation + ballastShoulder(absd);
  const w = smoothstep(0, BLEND_W, absd - SHOULDER); // 0 near track, 1 far out
  const normGround = lerp(bed, natural, w);

  const m = bandMembership(route, s);
  const lifted = lerp(normGround, natural, m);

  // Carve the tunnel bore: pull the lifted ground back to the bed near the track.
  const carve = boreCarve(route, s, absd);
  return lerp(lifted, bed, carve);
}

/** terrainHeight + clearance — the placement Y for a lineside prop (O7). */
export function anchorY(route: Route, s: number, d: number, clearance: number): number {
  return terrainHeight(route, s, d) + clearance;
}

/** Floor the eye Y at terrainHeight(s,eyeD) + MIN_EYE_CLEARANCE (O20). */
export function clampEye(route: Route, s: number, eyeD: number, eyeY: number): number {
  const floor = terrainHeight(route, s, eyeD) + MIN_EYE_CLEARANCE;
  return eyeY > floor ? eyeY : floor;
}
