// Frame-aware geometry + graph validation (HLD §3.3) — the ONLY new module that
// imports the spatial core (`centerline.ts`). It is the *sanctioned spatial-graph
// consumer*: deliberately OUTSIDE the O17 longitudinal fence. The existing
// geometry functions are NOT edited; these wrappers post-transform the local pose
// by the edge's `EdgeFrame` (a rigid rotation+translation), which is algebraically
// the O5b arc-composition lifted one level (an edge starts from its parent's exit
// frame). `EdgeFrame = IDENTITY_FRAME` reproduces the legacy single route exactly.
//
// Also hosts `validateGraph` (continuity + structural invariants) and the guarded
// `sliceRoute` used by the KINGSGATE-junction scenario. Pure: no clock, no random,
// no Three.js, no DOM.

import type { Route, Segment, Station, Signal } from "./route";
import {
  curvatureAt,
  speedLimitAt,
  minCurveRadius,
  AWS_MAGNET_OFFSET,
} from "./route";
import { planarPoseAt, heightAt } from "./centerline";
import { MAX_DT } from "./simulation";
import type { Edge, EdgeFrame, TrackGraph, Path } from "./graph";

// Mirrors of the pinned constants (DR-1: cant/radius checks live only as inline
// test oracles in the existing suite; centerline's CANT_* are module-private).
const CANT_GAIN = 0.08;
const CANT_MAX = 0.105;
const RADIUS_MIN = 250;
const P_LEN_SAFETY = 4; // edge length must exceed maxSpeed·MAX_DT by this margin

// ── frame-aware geometry (post-transform of the unchanged local pose) ─────────

/**
 * The world planar pose at chainage `s` on `edge`: the unchanged local
 * `planarPoseAt(edge.route, s)` rigidly rotated by `psi0` and translated to
 * `(x0,z0)`. Derivation: integrating the same curvature from heading ψ₀ rotates
 * every tangent by ψ₀, so the local displacement (∫sin φ, ∫cos φ) maps to
 * (cosψ₀·lx + sinψ₀·lz, −sinψ₀·lx + cosψ₀·lz). Identity frame ⇒ the legacy pose.
 */
export function planarPoseOnEdge(edge: Edge, s: number): { x: number; z: number; heading: number } {
  const l = planarPoseAt(edge.route, s);
  const { psi0, x0, z0 } = edge.frame;
  const c = Math.cos(psi0);
  const sn = Math.sin(psi0);
  return {
    x: x0 + c * l.x + sn * l.z,
    z: z0 - sn * l.x + c * l.z,
    heading: psi0 + l.heading,
  };
}

/** Height at `s` on `edge`: the edge's datum `h0` plus the unchanged local profile. */
export function heightOnEdge(edge: Edge, s: number): number {
  return edge.frame.h0 + heightAt(edge.route, s);
}

/**
 * The world point a lateral offset `d` from the spine at chainage `s` on `edge`
 * — `placeOnCentreline` generalised to a graph edge. right = (cos ψ, −sin ψ).
 * Returns the mathematical heading (render-side facing offsets stay render-side).
 */
export function placeOnEdge(
  edge: Edge,
  s: number,
  d: number,
): { x: number; y: number; z: number; heading: number } {
  const p = planarPoseOnEdge(edge, s);
  const rx = Math.cos(p.heading);
  const rz = -Math.sin(p.heading);
  return { x: p.x + d * rx, y: heightOnEdge(edge, s), z: p.z + d * rz, heading: p.heading };
}

/** The exit frame of `edge` (its world pose + height datum at `route.length`),
 *  used to derive each child edge's entry frame so continuity holds by
 *  construction. A node stores nothing — it is the equality entry(child)==exit(parent). */
export function exitFrame(edge: Edge): EdgeFrame {
  const p = planarPoseOnEdge(edge, edge.route.length);
  return { psi0: p.heading, x0: p.x, z0: p.z, h0: heightOnEdge(edge, edge.route.length) };
}

// ── validation ────────────────────────────────────────────────────────────────

export interface GraphDefect {
  kind:
    | "unknown-edge"
    | "discontinuity"
    | "short-edge"
    | "namespace"
    | "repeat-edge"
    | "radius"
    | "band-curved"
    | "cant"
    | "ribbon";
  edgeId?: string;
  pair?: [string, string];
  detail: string;
}

function frameClose(a: EdgeFrame, b: EdgeFrame, tol: number): boolean {
  return (
    Math.abs(a.psi0 - b.psi0) <= tol &&
    Math.abs(a.x0 - b.x0) <= tol &&
    Math.abs(a.z0 - b.z0) <= tol &&
    Math.abs(a.h0 - b.h0) <= tol
  );
}

/** Max posted speed limit over [from,to) — for the per-curve cant check. */
function maxSpeedOver(route: Route, from: number, to: number): number {
  let v = speedLimitAt(route, from);
  for (const seg of route.speedLimits) {
    if (seg.to > from && seg.from < to) v = Math.max(v, seg.value);
  }
  return v;
}

/** Every viaduct/tunnel band lies wholly on a κ=0 curvature segment? */
function bandsOnStraight(route: Route, edgeId: string, out: GraphDefect[]): void {
  const bands = [...(route.viaducts ?? []), ...(route.tunnels ?? [])];
  for (const b of bands) {
    const lo = b.center - b.halfLen;
    const hi = b.center + b.halfLen;
    for (const seg of route.curvatures) {
      if (seg.to > lo && seg.from < hi && seg.value !== 0) {
        out.push({
          kind: "band-curved",
          edgeId,
          detail: `band [${lo},${hi}] overlaps curved segment [${seg.from},${seg.to}] κ=${seg.value}`,
        });
        break;
      }
    }
  }
}

/** Per-edge geometry invariants (P3): radius, bands-on-straight, cant ceiling,
 *  and (if a render ribbon width is supplied) ribbon ≤ ½·minCurveRadius. */
function checkEdgeInvariants(
  edge: Edge,
  ribbonHalfWidth: number | undefined,
  out: GraphDefect[],
): void {
  const r = minCurveRadius(edge.route);
  if (r < RADIUS_MIN) {
    out.push({ kind: "radius", edgeId: edge.id, detail: `minCurveRadius ${r} < ${RADIUS_MIN}` });
  }
  bandsOnStraight(edge.route, edge.id, out);
  for (const seg of edge.route.curvatures) {
    if (seg.value === 0) continue;
    const v = maxSpeedOver(edge.route, seg.from, seg.to);
    const cant = CANT_GAIN * Math.abs(seg.value) * v * v;
    if (cant > CANT_MAX + 1e-9) {
      out.push({
        kind: "cant",
        edgeId: edge.id,
        detail: `cant ${cant.toFixed(4)} > ${CANT_MAX} on κ=${seg.value} at v=${v.toFixed(2)}`,
      });
    }
  }
  if (ribbonHalfWidth !== undefined && r !== Infinity && ribbonHalfWidth > 0.5 * r + 1e-9) {
    out.push({
      kind: "ribbon",
      edgeId: edge.id,
      detail: `ribbonHalfWidth ${ribbonHalfWidth} > 0.5·minCurveRadius ${r}`,
    });
  }
}

/**
 * Validate a track graph against the structural invariants the engine relies on.
 * Returns a (possibly empty) defect list; `main.ts` fails fast at startup.
 *
 *  - P2  : every parent→child join in every path has child.frame ≈ exitFrame(parent)
 *          (≤1e-6 in x0,z0,psi0,h0). At a merge, each parent shares the child frame.
 *  - P-LEN: every edge length > maxSpeed·MAX_DT·SAFETY (one join per tick, enforced).
 *  - OCC-NS: the station-id set and the edge-id set are disjoint (block tokens never
 *          alias station names).
 *  - NO-REPEAT: no path repeats an edge id (successor's first-match assumption holds).
 *  - P3  : per-edge radius / bands-on-straight / cant ceiling / ribbon.
 */
export function validateGraph(
  graph: TrackGraph,
  paths: Path[],
  stations: ReadonlySet<string>,
  maxSpeed: number,
  ribbonHalfWidth?: number,
): GraphDefect[] {
  const out: GraphDefect[] = [];
  const minLen = maxSpeed * MAX_DT * P_LEN_SAFETY;

  // OCC-NS
  for (const id of Object.keys(graph.edges)) {
    if (stations.has(id)) {
      out.push({ kind: "namespace", edgeId: id, detail: `edge id "${id}" aliases a station name` });
    }
  }

  // per-edge: P-LEN + P3
  for (const id of Object.keys(graph.edges)) {
    const edge = graph.edges[id] as Edge;
    if (edge.route.length <= minLen) {
      out.push({
        kind: "short-edge",
        edgeId: id,
        detail: `length ${edge.route.length} ≤ maxSpeed·MAX_DT·SAFETY ${minLen}`,
      });
    }
    checkEdgeInvariants(edge, ribbonHalfWidth, out);
  }

  // per-path: NO-REPEAT + P2 continuity
  for (const path of paths) {
    const seen = new Set<string>();
    for (let i = 0; i < path.length; i++) {
      const id = path[i] as string;
      if (seen.has(id)) {
        out.push({ kind: "repeat-edge", edgeId: id, detail: `path repeats edge "${id}"` });
      }
      seen.add(id);
      const edge = graph.edges[id];
      if (!edge) {
        out.push({ kind: "unknown-edge", edgeId: id, detail: `path references missing edge "${id}"` });
        continue;
      }
      if (i > 0) {
        const parentId = path[i - 1] as string;
        const parent = graph.edges[parentId];
        if (parent && !frameClose(edge.frame, exitFrame(parent), 1e-6)) {
          out.push({
            kind: "discontinuity",
            pair: [parentId, id],
            detail: `entry frame of "${id}" ≠ exit frame of "${parentId}"`,
          });
        }
      }
    }
  }
  return out;
}

// ── guarded route slicing (D-IMPL-2: KINGSGATE-junction decomposition) ────────

function sliceSegs<T>(segs: Segment<T>[], sFrom: number, sTo: number): Segment<T>[] {
  const out: Segment<T>[] = [];
  for (const seg of segs) {
    const lo = Math.max(seg.from, sFrom);
    const hi = Math.min(seg.to, sTo);
    if (hi > lo) out.push({ from: lo - sFrom, to: hi - sFrom, value: seg.value });
  }
  return out;
}

/**
 * Extract the sub-route [`sFrom`,`sTo`] of `route`, rebased to s=0. Cross-edge
 * GEOMETRY continuity is handled separately by `frame = exitFrame(parent)` — this
 * carves only the 1-D data. It is GUARDED: a cut that would corrupt the data
 * THROWS, so the decomposition is safe by construction. A cut (an interior end,
 * i.e. sFrom>0 or sTo<length) must:
 *  - fall on a κ=0 straight (clean join tangent, exact post-join extrapolation);
 *  - clear every platform (|station−cut| ≥ platformHalf);
 *  - clear every signal's post + AWS-magnet reach [post−AWS_MAGNET_OFFSET, post];
 *  - not truncate a viaduct/tunnel band.
 * Every retained signal's `protects` station must also be retained (no orphaned
 * cascade).
 */
export function sliceRoute(route: Route, sFrom: number, sTo: number): Route {
  if (!(sFrom >= 0 && sFrom < sTo && sTo <= route.length)) {
    throw new Error(`sliceRoute: bad range [${sFrom},${sTo}] of length ${route.length}`);
  }
  const cuts: number[] = [];
  if (sFrom > 0) cuts.push(sFrom);
  if (sTo < route.length) cuts.push(sTo);

  for (const cut of cuts) {
    if (curvatureAt(route, cut) !== 0) {
      throw new Error(`sliceRoute: cut at ${cut} is not on a κ=0 straight`);
    }
    for (const st of route.stations) {
      if (Math.abs(st.chainage - cut) < st.platformHalf) {
        throw new Error(`sliceRoute: cut at ${cut} straddles platform "${st.name}" (${st.chainage}±${st.platformHalf})`);
      }
    }
    for (const sig of route.signals) {
      if (cut > sig.chainage - AWS_MAGNET_OFFSET && cut < sig.chainage) {
        throw new Error(`sliceRoute: cut at ${cut} straddles the approach of signal @${sig.chainage}`);
      }
    }
    for (const b of [...(route.viaducts ?? []), ...(route.tunnels ?? [])]) {
      const lo = b.center - b.halfLen;
      const hi = b.center + b.halfLen;
      if (cut > lo && cut < hi) {
        throw new Error(`sliceRoute: cut at ${cut} truncates a band [${lo},${hi}]`);
      }
    }
  }

  const stations: Station[] = route.stations
    .filter((st) => st.chainage >= sFrom && st.chainage < sTo)
    .map((st) => ({ ...st, chainage: st.chainage - sFrom }));
  const kept = new Set(stations.map((st) => st.name));
  const signals: Signal[] = route.signals
    .filter((sig) => sig.chainage >= sFrom && sig.chainage < sTo)
    .map((sig) => ({ ...sig, chainage: sig.chainage - sFrom }));
  for (const sig of signals) {
    if (!kept.has(sig.protects)) {
      throw new Error(`sliceRoute: signal protects "${sig.protects}" not in the slice (orphaned cascade)`);
    }
  }
  const bandIn = <T extends { center: number; halfLen: number }>(b: T): boolean =>
    b.center - b.halfLen >= sFrom && b.center + b.halfLen <= sTo;

  const out: Route = {
    length: sTo - sFrom,
    stations,
    grades: sliceSegs(route.grades, sFrom, sTo),
    speedLimits: sliceSegs(route.speedLimits, sFrom, sTo),
    curvatures: sliceSegs(route.curvatures, sFrom, sTo),
    signals,
  };
  const viaducts = (route.viaducts ?? []).filter(bandIn).map((b) => ({ ...b, center: b.center - sFrom }));
  const tunnels = (route.tunnels ?? []).filter(bandIn).map((b) => ({ ...b, center: b.center - sFrom }));
  if (viaducts.length) out.viaducts = viaducts;
  if (tunnels.length) out.tunnels = tunnels;
  if (route.terrainSeed !== undefined) out.terrainSeed = route.terrainSeed;
  return out;
}
