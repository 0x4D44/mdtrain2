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

export interface Route {
  length: number;
  stations: Station[];
  /** Grade (rise/run) per segment; positive = uphill toward Eastbank. */
  grades: Segment<number>[];
  /** Posted speed limit per segment, m/s. */
  speedLimits: Segment<number>[];
  /** Track curvature 1/R (1/m) per segment; 0 = straight. */
  curvatures: Segment<number>[];
}

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
};

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
