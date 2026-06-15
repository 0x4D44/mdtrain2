// The route as data: chainage (m) from Westford (0) to Eastbank. An improved
// take on the original mdtrain line — same five stops, but now with gradients,
// curvature and posted speed limits the physics actually responds to. Profiles
// are piecewise; lookups clamp to the ends.

export interface Station {
  name: string;
  /** Stop board chainage, m. */
  chainage: number;
  /** Half the platform length, m (stop tolerance lives in scoring). */
  platformHalf: number;
}

export interface Segment<T> {
  from: number; // chainage start, m
  to: number; // chainage end, m
  value: T;
}

/** Colour-light aspect, derived (never stored). */
export type Aspect = "RED" | "YELLOW" | "DOUBLE_YELLOW" | "GREEN";

export interface Signal {
  /** Signal-post chainage, m. The single stored chainage.
   *  Starter authoring rule = station stop-board chainage + STARTER_OFFSET
   *  (post sits JUST PAST the platform). The AWS magnet (chainage −
   *  AWS_MAGNET_OFFSET) and OSS loop (chainage − OSS_LOOP_OFFSET) are derived
   *  at use-site, never stored. */
  chainage: number;
  /** Station whose unserved booked stop holds this starter RED.
   *  Every signal is a station starter; there are no plain block signals. */
  protects: string;
}

export interface Route {
  length: number;
  stations: Station[];
  /** Grade (rise/run) per segment; positive = uphill toward Eastbank. */
  grades: Segment<number>[];
  /** Posted speed limit per segment, m/s. */
  speedLimits: Segment<number>[];
  /** Track curvature 1/R (1/m) per segment; 0 = straight. */
  curvatures: Segment<number>[];
  /** Station starters, sorted ASCENDING by chainage (authoring invariant).
   *  No block signals; no terminus starter. */
  signals: Signal[];
  /** Viaduct bands (HLD §2.5). `valleyDepth > 0` ⇒ the macro ground is lowered
   *  by `valleyDepth` (macroReliefAt = −valleyDepth), i.e. the natural ground sits
   *  BELOW the formation and the line is carried on a deck + piers. Optional and
   *  omitted by physics/signalling fixtures (`WESTFORD_EASTBANK`). */
  viaducts?: { center: number; halfLen: number; valleyDepth: number }[];
  /** Tunnel bands (HLD §2.5). `hillHeight > 0` ⇒ the macro ground is raised by
   *  `hillHeight` (macroReliefAt = +hillHeight), i.e. the natural ground sits
   *  ABOVE the formation and the line runs through a bore. Optional. */
  tunnels?: { center: number; halfLen: number; hillHeight: number }[];
  /** Value-noise seed for the terrain ground field; default 1 at the use-site. */
  terrainSeed?: number;
}

/** Post = station stop-board chainage + this (post sits just past the platform). */
export const STARTER_OFFSET = 120;
/** AWS magnet = post − this. */
export const AWS_MAGNET_OFFSET = 180;
/** OSS loop = post − this. */
export const OSS_LOOP_OFFSET = 50;

const MPH = 0.44704;

export const WESTFORD_EASTBANK: Route = {
  length: 6_000,
  stations: [
    { name: "Westford", chainage: 0, platformHalf: 90 },
    { name: "Riverside", chainage: 1_500, platformHalf: 90 },
    { name: "City Centre", chainage: 3_100, platformHalf: 100 },
    { name: "Victoria Street", chainage: 4_400, platformHalf: 90 },
    { name: "Eastbank", chainage: 6_000, platformHalf: 90 },
  ],
  grades: [
    { from: 0, to: 900, value: 0.0 },
    { from: 900, to: 1_500, value: 0.012 }, // 1.2% climb into Riverside
    { from: 1_500, to: 2_600, value: -0.008 }, // down toward the river
    { from: 2_600, to: 3_100, value: 0.0 },
    { from: 3_100, to: 4_400, value: 0.006 }, // gentle climb through town
    { from: 4_400, to: 6_000, value: -0.01 }, // falling to the Eastbank terminus
  ],
  speedLimits: [
    { from: 0, to: 1_400, value: 50 * MPH },
    { from: 1_400, to: 1_600, value: 25 * MPH }, // Riverside approach
    { from: 1_600, to: 3_000, value: 60 * MPH },
    { from: 3_000, to: 3_200, value: 20 * MPH }, // City Centre curves
    { from: 3_200, to: 4_300, value: 50 * MPH },
    { from: 4_300, to: 4_500, value: 25 * MPH }, // Victoria Street
    { from: 4_500, to: 5_700, value: 45 * MPH },
    { from: 5_700, to: 6_000, value: 15 * MPH }, // into the buffer stops
  ],
  curvatures: [
    { from: 0, to: 1_400, value: 0 },
    { from: 1_400, to: 1_600, value: 1 / 400 },
    { from: 1_600, to: 3_000, value: 0 },
    { from: 3_000, to: 3_200, value: 1 / 250 },
    { from: 3_200, to: 6_000, value: 0 },
  ],
  // Station starters only (no block signals, no terminus starter). Posts sit
  // just past each platform: post = station board + STARTER_OFFSET(=120).
  // Westford (origin) and Eastbank (terminus) get no starter.
  signals: [
    { chainage: 1_620, protects: "Riverside" }, // S1: board 1500 + 120
    { chainage: 3_220, protects: "City Centre" }, // S2: board 3100 + 120
    { chainage: 4_520, protects: "Victoria Street" }, // S3: board 4400 + 120
  ],
};

/**
 * KINGSGATE → SEAHAVEN — the Grand Route (HLD §2.5), ~14 km, 7 chapters:
 * a city terminus through suburb and country, over the Wyre Viaduct, along the
 * Brinemouth coast, through the Stonehead Tunnel, to a seaside terminus.
 *
 * HARD invariants (O19/O19b/O-RIBBON):
 *  - every non-zero curvature ⇒ radius ≥ 400 m (here R=800 Wealdham, R=500
 *    Brinemouth ⇒ minCurveRadius = 500 ≥ 400, so 0.5·min ≥ 180 = desktop ribbon).
 *  - the viaduct band [7500,8600] and tunnel band [11000,12400] lie WHOLLY on
 *    κ=0 curvature segments (straight piers / straight bore axis).
 *  - grades gentle (|grade| ≤ 0.02); grades/speedLimits/curvatures cover
 *    [0,14000] contiguously ascending.
 *  - signals are station starters (post = board + STARTER_OFFSET=120), ascending;
 *    no starter at the Kingsgate origin or the Seahaven terminus.
 */
export const KINGSGATE_SEAHAVEN: Route = {
  length: 14_000,
  stations: [
    { name: "Kingsgate", chainage: 0, platformHalf: 120 }, // Ch1 city terminus
    { name: "Ashcombe", chainage: 2_000, platformHalf: 90 }, // Ch2 suburb
    { name: "Wealdham", chainage: 5_800, platformHalf: 90 }, // Ch3 country
    { name: "Brinemouth", chainage: 9_800, platformHalf: 90 }, // Ch5 coast
    { name: "Seahaven", chainage: 14_000, platformHalf: 110 }, // Ch7 sea terminus
  ],
  grades: [
    { from: 0, to: 1_800, value: 0.0 }, // Ch1 Kingsgate cutting, level
    { from: 1_800, to: 3_000, value: 0.01 }, // Ch2 1.0% climb onto the embankment
    { from: 3_000, to: 4_200, value: 0.0 }, // top of the suburb
    { from: 4_200, to: 7_500, value: -0.004 }, // Ch3 country, a gentle fall
    { from: 7_500, to: 8_600, value: 0.0 }, // Ch4 viaduct deck, level
    { from: 8_600, to: 11_000, value: -0.012 }, // Ch5 falling to the sea
    { from: 11_000, to: 12_400, value: 0.0 }, // Ch6 tunnel, level
    { from: 12_400, to: 14_000, value: -0.006 }, // Ch7 low embankment to the buffers
  ],
  speedLimits: [
    { from: 0, to: 600, value: 25 * MPH }, // out of Kingsgate platforms
    { from: 600, to: 1_700, value: 60 * MPH }, // Ch1 cutting
    { from: 1_700, to: 2_300, value: 30 * MPH }, // Ashcombe approach/platform
    { from: 2_300, to: 4_400, value: 70 * MPH }, // Ch2 suburb run
    { from: 4_400, to: 4_700, value: 50 * MPH }, // into the Wealdham curve
    { from: 4_700, to: 7_000, value: 55 * MPH }, // Ch3 country / sweeping curve
    { from: 7_000, to: 9_200, value: 75 * MPH }, // viaduct & approaches
    { from: 9_200, to: 9_500, value: 40 * MPH }, // Brinemouth shore curve
    { from: 9_500, to: 10_100, value: 30 * MPH }, // Brinemouth platform
    { from: 10_100, to: 10_900, value: 50 * MPH }, // toward Stonehead
    { from: 10_900, to: 12_500, value: 60 * MPH }, // through the tunnel
    { from: 12_500, to: 13_400, value: 45 * MPH }, // Ch7 coastal run-in
    { from: 13_400, to: 14_000, value: 15 * MPH }, // into the buffer stops
  ],
  curvatures: [
    { from: 0, to: 4_500, value: 0 }, // Ch1-2 city + suburb, straight
    { from: 4_500, to: 7_000, value: 1 / 800 }, // Ch3 Wealdham sweep, R=800
    { from: 7_000, to: 9_200, value: 0 }, // straight: carries the viaduct band 7500-8600
    { from: 9_200, to: 10_800, value: 1 / 500 }, // Ch5 Brinemouth shore, R=500
    { from: 10_800, to: 14_000, value: 0 }, // straight: carries the tunnel band 11000-12400
  ],
  // Station starters only (no block signals, no terminus starter). Posts sit just
  // past each platform: post = station board + STARTER_OFFSET(=120). Kingsgate
  // (origin) and Seahaven (terminus) get no starter.
  signals: [
    { chainage: 2_120, protects: "Ashcombe" }, // board 2000 + 120
    { chainage: 5_920, protects: "Wealdham" }, // board 5800 + 120
    { chainage: 9_920, protects: "Brinemouth" }, // board 9800 + 120
  ],
  // Ch4 Wyre Viaduct (no stop): deck at formation, piers to the valley floor.
  viaducts: [{ center: 8_050, halfLen: 320, valleyDepth: 45 }],
  // Ch6 Stonehead Tunnel (no stop): hill ground + bore + portals over the band.
  tunnels: [{ center: 11_700, halfLen: 380, hillHeight: 60 }],
  terrainSeed: 1,
};

/**
 * The tightest curve on the route: `1 / max(|κ|)` over the non-zero curvature
 * segments, or `+Infinity` if every segment is straight. The helper O-RIBBON
 * references (`ribbonHalfWidth ≤ 0.5·minCurveRadius` for terrain-rendered routes).
 */
export function minCurveRadius(route: Route): number {
  let maxAbsKappa = 0;
  for (const seg of route.curvatures) {
    const a = Math.abs(seg.value);
    if (a > maxAbsKappa) maxAbsKappa = a;
  }
  return maxAbsKappa === 0 ? Infinity : 1 / maxAbsKappa;
}

function lookup<T>(segments: Segment<T>[], s: number, fallback: T): T {
  for (const seg of segments) {
    if (s >= seg.from && s < seg.to) return seg.value;
  }
  // clamp to ends
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first && s < first.from) return first.value;
  if (last && s >= last.to) return last.value;
  return fallback;
}

export function gradeAt(route: Route, s: number): number {
  return lookup(route.grades, s, 0);
}

export function speedLimitAt(route: Route, s: number): number {
  return lookup(route.speedLimits, s, route.speedLimits[0]?.value ?? 0);
}

export function curvatureAt(route: Route, s: number): number {
  return lookup(route.curvatures, s, 0);
}

/**
 * The aspect of signal `i`, a pure adjacent-starter cascade (no train, no dt).
 * A starter is RED iff its protected station is NOT in `served`; otherwise it
 * shows one R→Y→YY→G rung per signal ahead toward Eastbank. Tests own held-red
 * FIRST, then looks one signal ahead. Recursion depth ≤ signals.length (index
 * strictly increases ⇒ no cycles); terminates at the last starter.
 */
export function aspectAt(route: Route, i: number, served: ReadonlySet<string>): Aspect {
  const sig = route.signals[i];
  if (!sig) return "GREEN"; // guard (noUncheckedIndexedAccess) / out of range
  if (!served.has(sig.protects)) return "RED"; // OWN held-red first
  const ahead = route.signals[i + 1]; // next starter toward Eastbank
  if (!ahead) return "GREEN"; // last starter, nothing ahead
  const aheadAspect = aspectAt(route, i + 1, served);
  if (aheadAspect === "RED") return "YELLOW";
  if (aheadAspect === "YELLOW") return "DOUBLE_YELLOW";
  return "GREEN";
}

/**
 * Nearest signal AHEAD of `s` in travel direction `dir`, or null. Signals face
 * forward only: for dir = -1 (reverse running) there is no protecting starter
 * ahead, so this returns null (the HUD then shows GREEN).
 */
export function nextSignalAhead(
  route: Route,
  s: number,
  dir: 1 | -1,
): { i: number; sig: Signal } | null {
  if (dir === -1) return null;
  for (let i = 0; i < route.signals.length; i++) {
    const sig = route.signals[i];
    if (sig && sig.chainage > s) return { i, sig };
  }
  return null;
}

/**
 * Indices of any positions in `points` lying in the forward swept interval
 * (sPrev, sNow]. Generic over an arbitrary position array so one query serves
 * signal posts, AWS magnets, and OSS loops alike; returned indices map straight
 * back to the index in `points`. Forward-only: reverse/standing crosses nothing.
 */
export function pointsCrossedFwd(points: number[], sPrev: number, sNow: number): number[] {
  if (sNow <= sPrev) return []; // reverse / standing crosses nothing
  const crossed: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p !== undefined && p > sPrev && p <= sNow) crossed.push(i);
  }
  return crossed;
}
