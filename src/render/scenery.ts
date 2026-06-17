// Lineside scenery (impure Three.js, screenshot-verified). The faked relief is
// GONE: the real terrain ribbon (terrain-mesh.ts) now carves cuttings, carries
// embankments and raises the hills, so the old cone-"hills" and sloped-box
// `addBank` cuttings/embankments are deleted. What remains is genuine lineside
// PROPS — tree clumps, road overbridges and platform people — every one placed
// through the PURE curvilinear core so it follows the bent, undulating line:
//
//   (x, z, heading) ← placeOnCentreline(route, s, d)   (D21: math heading; the
//                                                        Three +π facing is applied
//                                                        render-side where needed)
//   ground Y        ← anchorY(route, s, d, clearance)   (props sit ON the terrain)
//
// Props avoid the open viaduct valley (`viaductSpanAt`) and the render-omitted
// tunnel bore corridor (`boreCorridorAt`) so nothing floats over the gap or sits
// inside the bore. Everything is built ONCE from instanced/simple geometry with
// ZERO per-frame allocation; it is static (the global env lighting does the rest).
//
// LOD note (for scene.ts / R3): true runtime LOD needs the eye position, which
// scenery does not have at build time (props are placed once at static (s,d)).
// `lodForDistance` is therefore a render-time tool, not a build-time one; here we
// keep the cheap instanced builds and simply place fewer props far from the track.
// If per-prop runtime LOD is wanted, scene.ts owns the camera and can cull groups.

import * as THREE from "three";
import type { Route } from "../sim/route";
import { placeOnCentreline } from "../sim/centerline";
import { anchorY, formationHeight, viaductSpanAt, boreCorridorAt } from "../sim/terrain";

/** Deterministic PRNG (mulberry32) so scenery placement is stable run-to-run. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TMP_M = new THREE.Matrix4();
const TMP_P = new THREE.Vector3();
const TMP_S = new THREE.Vector3();
const NOROT = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Place instance `i` of `mesh` at a position/scale (no rotation). */
function placeBox(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  TMP_M.compose(TMP_P.set(x, y, z), NOROT, TMP_S.set(sx, sy, sz));
  mesh.setMatrixAt(i, TMP_M);
}

/**
 * Build all lineside props under `scene`, every one positioned through the pure
 * curvilinear core so it follows the real (curved, undulating) line and sits on
 * the real terrain. The flat ground, cone hills and faked banks are gone (the
 * terrain ribbon provides the relief). Built ONCE; no per-frame allocation.
 *
 * Signature unchanged from the straight-line version so scene.ts (R3) keeps its
 * `buildScenery(scene, route, gauge)` call site; `gauge` sizes the track-edge
 * clearances. LOD is render-time (needs the eye) — see the file header.
 */
export function buildScenery(scene: THREE.Scene, route: Route, gauge: number): void {
  buildTrees(scene, route, gauge);
  buildBushes(scene, route, gauge); // low foliage / hedgerows between the trees
  buildBuildings(scene, route, gauge); // city cluster ~Kingsgate, suburb ~Ashcombe
  // Road overbridges at sensible places on the route, clear of the viaduct valley
  // and the tunnel hill (each builder skips bad chainages internally).
  buildOverbridge(scene, route, gauge, 1200, 0x5a5e66); // concrete bridge in the Kingsgate cutting
  buildOverbridge(scene, route, gauge, 3000, 0x6b5747); // brick road overbridge (Ashcombe)
  buildOverbridge(scene, route, gauge, 4000, 0x53585f); // a concrete one further on
  buildOverbridge(scene, route, gauge, 6600, 0x6b5747); // brick bridge in the country run
  buildPlatformPeople(scene, route, gauge);
}

/**
 * Clumps of trees both sides: a trunk mesh + a foliage mesh, instanced. Each tree
 * is placed at a curvilinear (s, d): `placeOnCentreline` gives world (x, z) and
 * the base Y comes from `anchorY(s, d, 0)` so the trunk meets the actual ground
 * (cutting floor, embankment top, hill flank). Trees that would land over the
 * open viaduct valley or inside the tunnel bore corridor are skipped.
 */
function buildTrees(scene: THREE.Scene, route: Route, gauge: number): void {
  const len = route.length;
  const rnd = makeRng(8675309);
  const N = 720; // denser woodland (was 360) — #5
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 1 });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.26, 1, 6), trunkMat, N);
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x33602f, roughness: 1, flatShading: true });
  const foliage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), foliageMat, N);
  const minD = gauge / 2 + 7; // clear of the track / fence
  let placed = 0;
  let guard = 0;
  while (placed < N && guard < N * 4) {
    guard++;
    // Clump: pick a clump centre (chainage cs, side), then jitter for a cluster.
    const cs = rnd() * len;
    const side = rnd() < 0.5 ? -1 : 1;
    // Lateral offset of the clump centre; the rnd()*rnd() bias keeps most clumps
    // near the line (denser close in, sparser far out — a cheap distance falloff).
    const cd = side * (minD + rnd() * rnd() * 150);
    const clump = 3 + Math.floor(rnd() * 5);
    for (let c = 0; c < clump && placed < N; c++) {
      const s = cs + (rnd() - 0.5) * 28;
      const d = cd + (rnd() - 0.5) * 22;
      if (Math.abs(d) < minD || s < 0 || s > len) continue;
      // Skip the open valley (no ground to stand on) and the bore corridor.
      if (viaductSpanAt(route, s) || boreCorridorAt(route, s, d)) continue;
      const place = placeOnCentreline(route, s, d);
      const baseY = anchorY(route, s, d, 0); // trunk foot ON the terrain
      const h = 4 + rnd() * 7; // tree height, m
      const trunkH = h * 0.45;
      placeBox(trunks, placed, place.x, baseY + trunkH / 2, place.z, 1, trunkH, 1);
      const fr = h * 0.42; // foliage radius
      TMP_M.compose(TMP_P.set(place.x, baseY + trunkH + fr * 0.7, place.z), NOROT, TMP_S.set(fr, fr * 1.25, fr));
      foliage.setMatrixAt(placed, TMP_M);
      placed++;
    }
  }
  // Park any unused instances far below ground (cheap, avoids a wrong count).
  for (let i = placed; i < N; i++) {
    placeBox(trunks, i, 0, -1000, 0, 1, 1, 1);
    placeBox(foliage, i, 0, -1000, 0, 1, 1, 1);
  }
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  trunks.frustumCulled = false;
  foliage.frustumCulled = false;
  scene.add(trunks);
  scene.add(foliage);
}

/**
 * Low foliage — bushes and rough hedgerows — filling the gap between the bare
 * ground and the tree canopy (#5). One squashed-icosahedron InstancedMesh, placed
 * in clumps like the trees but lower, denser and closer in to the line. Each sits
 * ON the terrain via `anchorY`, skipping the open viaduct valley and the bore.
 * Density falls off with |d| (the rnd()*rnd() lateral bias). Built ONCE.
 */
function buildBushes(scene: THREE.Scene, route: Route, gauge: number): void {
  const len = route.length;
  const rnd = makeRng(1234567);
  const N = 520;
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x2c5128, roughness: 1, flatShading: true });
  const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), bushMat, N);
  const minD = gauge / 2 + 6; // a little closer in than the trees
  let placed = 0;
  let guard = 0;
  while (placed < N && guard < N * 4) {
    guard++;
    const cs = rnd() * len;
    const side = rnd() < 0.5 ? -1 : 1;
    // Closer to the line than the trees (smaller spread) → reads as hedgerows.
    const cd = side * (minD + rnd() * rnd() * 90);
    const clump = 4 + Math.floor(rnd() * 6);
    for (let c = 0; c < clump && placed < N; c++) {
      const s = cs + (rnd() - 0.5) * 24;
      const d = cd + (rnd() - 0.5) * 10; // tight lateral spread → a rough hedge line
      if (Math.abs(d) < minD || s < 0 || s > len) continue;
      if (viaductSpanAt(route, s) || boreCorridorAt(route, s, d)) continue;
      const place = placeOnCentreline(route, s, d);
      const baseY = anchorY(route, s, d, 0);
      const rx = 0.7 + rnd() * 0.9; // bush half-width, m
      const ry = 0.5 + rnd() * 0.5; // bush half-height, m (low)
      TMP_M.compose(TMP_P.set(place.x, baseY + ry * 0.8, place.z), NOROT, TMP_S.set(rx, ry, rx));
      bushes.setMatrixAt(placed, TMP_M);
      placed++;
    }
  }
  for (let i = placed; i < N; i++) placeBox(bushes, i, 0, -1000, 0, 1, 1, 1);
  bushes.instanceMatrix.needsUpdate = true;
  bushes.frustumCulled = false;
  scene.add(bushes);
}

/**
 * Lineside buildings (#5): a dense city cluster near the Kingsgate terminus
 * (chainage 0–1800, the level cutting span) and lower suburban blocks around
 * Ashcombe (~2000). One box InstancedMesh, per-instance scaled to a building size
 * and tinted (instanceColor). Each block sits ON the terrain via `anchorY` and is
 * set BACK from the line (beyond the fence), skipping the viaduct valley and bore.
 * Density and height fall off with |d| and away from the urban centres. Built ONCE.
 */
function buildBuildings(scene: THREE.Scene, route: Route, gauge: number): void {
  const len = route.length;
  const rnd = makeRng(20260617);
  const N = 240;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  const tints = [0x3a3d44, 0x46413b, 0x3d4248, 0x4a4540, 0x363a40, 0x504a42];
  const minD = gauge / 2 + 12; // well back from the line, beyond the fence
  const col = new THREE.Color();
  // Two urban zones: (centre chainage, half-length, max height, lateral reach).
  const zones = [
    { c: 700, half: 1100, maxH: 26, reach: 150 }, // Kingsgate city (0–1800)
    { c: 2000, half: 700, maxH: 12, reach: 110 }, // Ashcombe suburb (~2000)
  ];
  let placed = 0;
  let guard = 0;
  while (placed < N && guard < N * 6) {
    guard++;
    const zone = zones[Math.floor(rnd() * zones.length)];
    if (!zone) continue;
    const s = zone.c + (rnd() - 0.5) * 2 * zone.half;
    if (s < 0 || s > len) continue;
    const side = rnd() < 0.5 ? -1 : 1;
    // rnd()*rnd() biases blocks close in (denser by the line, sparser far out).
    const d = side * (minD + rnd() * rnd() * zone.reach);
    if (viaductSpanAt(route, s) || boreCorridorAt(route, s, d)) continue;
    const place = placeOnCentreline(route, s, d);
    const baseY = anchorY(route, s, d, 0);
    // Taller close in, shorter far out; jittered. Footprint scales loosely with it.
    const near = 1 - Math.min(1, Math.abs(d) / (minD + zone.reach));
    const h = 4 + near * zone.maxH * (0.4 + rnd() * 0.6);
    const w = 5 + rnd() * 9;
    const dpt = 5 + rnd() * 9;
    TMP_M.compose(TMP_P.set(place.x, baseY + h / 2, place.z), NOROT, TMP_S.set(w, h, dpt));
    blocks.setMatrixAt(placed, TMP_M);
    const tint = tints[Math.floor(rnd() * tints.length)] ?? 0x3a3d44;
    blocks.setColorAt(placed, col.setHex(tint));
    placed++;
  }
  for (let i = placed; i < N; i++) placeBox(blocks, i, 0, -1000, 0, 1, 1, 1);
  blocks.instanceMatrix.needsUpdate = true;
  if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  blocks.frustumCulled = false;
  scene.add(blocks);
}

/**
 * A road overbridge crossing the line at chainage `s`: deck, two abutments,
 * parapets. The whole bridge is a Group placed and rotated by `placeOnCentreline`
 * so it spans the formation square to the (possibly curved) track, with deck and
 * abutment heights taken relative to `formationHeight(s)` (the rail top). Skipped
 * if the chainage falls in the viaduct valley or tunnel band (no road there).
 */
function buildOverbridge(scene: THREE.Scene, route: Route, gauge: number, s: number, color: number): void {
  if (s < 0 || s > route.length) return;
  if (viaductSpanAt(route, s) || boreCorridorAt(route, s, 0)) return;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const span = 16; // total width across the formation, m
  const railTop = formationHeight(route, s); // rail/deck top at this chainage
  const deckClear = 6.2; // soffit/deck height above the rail top, m
  const deckY = railTop + deckClear;
  const deckThick = 0.7;
  const place = placeOnCentreline(route, s, 0);

  const g = new THREE.Group();
  g.position.set(place.x, 0, place.z);
  g.quaternion.setFromAxisAngle(Y_AXIS, place.heading); // align the bridge to the track

  // Deck (long axis across the track = local X; spans over the line along local Z).
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, deckThick, 4.5), mat);
  deck.position.set(0, deckY, 0);
  g.add(deck);
  // Parapets (low walls along both deck edges).
  for (const pz of [-2.0, 2.0]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(span, 1.0, 0.3), mat);
    wall.position.set(0, deckY + 0.85, pz);
    g.add(wall);
  }
  // Abutments either side of the track, their feet on the formation.
  for (const ad of [-(gauge / 2 + 4.5), gauge / 2 + 4.5]) {
    const ab = new THREE.Mesh(new THREE.BoxGeometry(3, deckClear, 5), mat);
    ab.position.set(ad * 1.6, railTop + deckClear / 2, 0);
    g.add(ab);
  }
  scene.add(g);
}

/**
 * A few simple standing figures on each platform. Each is placed via
 * `placeOnCentreline` along the platform (so it follows a curved platform) at a
 * lateral offset onto the +X platform slab, and stood on the slab TOP (which sits
 * `platTop` above the rail formation — NOT on the natural ground, so the Y is
 * formation-relative, matching the platform slab buildStation lays down).
 */
function buildPlatformPeople(scene: THREE.Scene, route: Route, gauge: number): void {
  const rnd = makeRng(54321);
  const platformD = gauge / 2 + 0.7 + 1.0; // a little in from the platform edge (+X side)
  const platTop = 0.9; // platform surface height above the formation
  const coats = [0x8a3b32, 0x32506e, 0x35503a, 0x5a4a32, 0x40424a]; // muted clothing
  const total = route.stations.length * 4;
  const bodies = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.22, 0.9, 3, 6),
    new THREE.MeshStandardMaterial({ roughness: 1 }),
    total,
  );
  const heads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xc8a98a, roughness: 1 }),
    total,
  );
  const col = new THREE.Color();
  let i = 0;
  for (const st of route.stations) {
    const base = formationHeight(route, st.chainage) + platTop; // slab top at the station
    const n = 4;
    for (let k = 0; k < n; k++) {
      const s = st.chainage + (rnd() - 0.5) * 2 * (st.platformHalf - 12);
      const d = platformD + (rnd() - 0.5) * 1.4;
      const place = placeOnCentreline(route, s, d);
      TMP_M.compose(TMP_P.set(place.x, base + 0.85, place.z), NOROT, TMP_S.set(1, 1, 1));
      bodies.setMatrixAt(i, TMP_M);
      const c = coats[k % coats.length] ?? 0x808080;
      bodies.setColorAt(i, col.setHex(c));
      TMP_M.compose(TMP_P.set(place.x, base + 1.55, place.z), NOROT, TMP_S.set(1, 1, 1));
      heads.setMatrixAt(i, TMP_M);
      i++;
    }
  }
  bodies.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  scene.add(bodies);
  scene.add(heads);
}
