// The track-graph types (HLD §3.2): the existing single-route geometry with its
// integration origin un-hardwired. An `Edge` is a `Route` read through an
// `EdgeFrame` (the per-edge integration origin); `EdgeFrame = IDENTITY_FRAME`
// reproduces today's single route byte-for-byte. Pure TYPES + `successor` only —
// imports `route.ts` for the `Route` type and nothing spatial, so this module is
// inside the O17 longitudinal fence (no centerline, no clock, no randomness).

import type { Route } from "./route";

/**
 * The per-edge integration origin: the world pose (`x0`,`z0`,heading `psi0`) and
 * height datum `h0` from which the edge's local route geometry is read. The
 * identity frame reproduces the legacy single-route origin (ψ₀=0 at (0,0,0)).
 */
export interface EdgeFrame {
  psi0: number;
  x0: number;
  z0: number;
  h0: number;
}

export const IDENTITY_FRAME: EdgeFrame = { psi0: 0, x0: 0, z0: 0, h0: 0 };

/** A graph edge: a `Route` (reused verbatim) read through an `EdgeFrame`. */
export interface Edge {
  id: string;
  route: Route;
  frame: EdgeFrame;
}

/** Where a train is: which edge, how far along (`s`, m), and a constant render
 *  offset (`d`, m). `d` is a mesh nudge only — never a routing degree of freedom
 *  (D-DEC-8). */
export interface TrainPosition {
  edgeId: string;
  s: number;
  d: number;
}

/** A booked route: an ordered list of edge ids, parent→child. Points are baked
 *  into the data; there is no runtime pathfinding (HLD §1.2). */
export type Path = string[];

/** A bag of edges; adjacency lives in the `Path`s, joined by `exit == entry`
 *  (checked by `validateGraph`). */
export interface TrackGraph {
  edges: Record<string, Edge>;
}

/**
 * The edge that follows `edgeId` on `path`, or `null` if `edgeId` is the last
 * edge (or absent). Uses the first index match — `validateGraph`'s NO-REPEAT
 * invariant guarantees an edge id appears at most once per path, so the first
 * match is the only match.
 */
export function successor(path: Path, edgeId: string): string | null {
  const i = path.indexOf(edgeId);
  return i >= 0 && i + 1 < path.length ? (path[i + 1] as string) : null;
}
