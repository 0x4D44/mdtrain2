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
import { buildFacade } from "./textures";

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

/** Handle returned by `buildScenery` for the per-frame env updates scene.ts owns. */
export interface SceneryHandle {
  /** The lit-window building material — scene.ts fades its emissive by nightFactor
   *  so windows glow at dusk/night but go dark by day (not burning through noon). */
  buildingMat: THREE.MeshStandardMaterial;
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
export function buildScenery(scene: THREE.Scene, route: Route, gauge: number): SceneryHandle {
  buildTrees(scene, route, gauge);
  buildBushes(scene, route, gauge); // low foliage / hedgerows between the trees
  const buildingMat = buildBuildings(scene, route, gauge); // city ~Kingsgate, suburb ~Ashcombe
  // Road overbridges at sensible places on the route, clear of the viaduct valley
  // and the tunnel hill (each builder skips bad chainages internally).
  buildOverbridge(scene, route, gauge, 1200, 0x5a5e66); // concrete bridge in the Kingsgate cutting
  buildOverbridge(scene, route, gauge, 3000, 0x6b5747); // brick road overbridge (Ashcombe)
  buildTrussBridge(scene, route, 4000); // the hero moonlit steel through-truss
  buildOverbridge(scene, route, gauge, 6600, 0x6b5747); // brick bridge in the country run
  buildPlatformPeople(scene, route, gauge);
  buildMarkerLights(scene, route, gauge); // warm ballast-edge glints (HLD §2.E)
  return { buildingMat };
}

/**
 * Warm trackside marker lights (HLD §2.E): small emissive glints just off the
 * ballast edge, alternating sides every ~24 m, that bloom at night into a lit
 * lineside corridor. ONE InstancedMesh, emissive-only (no PointLight, so no
 * R1/DL4 cost), placed via `placeOnCentreline` + `anchorY` so each sits ON the
 * ground, skipping the viaduct valley and tunnel bore. Built ONCE.
 */
function buildMarkerLights(scene: THREE.Scene, route: Route, gauge: number): void {
  const len = route.length;
  const step = 24;
  const N = Math.max(1, Math.floor(len / step));
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a,
    emissive: 0xfff0d0,
    emissiveIntensity: 2.2,
  });
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 6, 6), mat, N);
  const d0 = gauge / 2 + 1.6; // just outside the ballast shoulder
  for (let i = 0; i < N; i++) {
    const s = (i + 1) * step;
    const side = i % 2 ? 1 : -1;
    const d = side * d0;
    if (s > len || viaductSpanAt(route, s) || boreCorridorAt(route, s, d)) {
      placeBox(mesh, i, 0, -1000, 0, 1, 1, 1); // park: no ground here
      continue;
    }
    const place = placeOnCentreline(route, s, d);
    placeBox(mesh, i, place.x, anchorY(route, s, d, 0.4), place.z, 1, 1, 1);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
}

/** A live traffic system: built once, stepped each frame from scene.ts. */
export interface TrafficHandle {
  /** Advance every car by `dt` seconds and re-write the instance matrices. */
  update(dt: number): void;
}

/**
 * Deterministic road traffic alongside the line (HLD §2.F, optional). A handful
 * of cars run on notional roads either side of the railway, within a flat open-
 * country chainage band, each a dark body with emissive white headlights and red
 * tail-lights — so at night you read sweeping head/tail-lights without any road
 * mesh. Bodies / headlights / tail-lights are THREE InstancedMeshes (≈3 draw
 * calls for ALL cars); the per-frame `update` only re-writes matrices (NO
 * allocation). Placement is seeded and stepping is `speed·dt` — no `Math.random`
 * in the loop (DL3) — and the lights are emissive-only, ZERO PointLights (DL4).
 */
export function buildTraffic(scene: THREE.Scene, route: Route, gauge: number): TrafficHandle {
  // A tight band of flat open country straddling the hero truss (4000), so the
  // cars stay dense enough to read on the approach rather than scattered over km.
  const BAND_LO = 3950;
  const BAND_HI = 4600;
  const BAND = BAND_HI - BAND_LO;
  const rnd = makeRng(0x0ca4ca4e);
  const lanes = [
    { d: -(gauge / 2 + 12), dir: 1 },
    { d: -(gauge / 2 + 17), dir: -1 },
    { d: gauge / 2 + 14, dir: -1 },
  ];
  const perLane = 6;
  const cars: { s: number; d: number; dir: number; speed: number }[] = [];
  for (const lane of lanes) {
    for (let k = 0; k < perLane; k++) {
      cars.push({
        s: BAND_LO + (k / perLane) * BAND + rnd() * 50,
        d: lane.d,
        dir: lane.dir,
        speed: 9 + rnd() * 7, // ~20–36 mph
      });
    }
  }
  const N = cars.length;

  const bodies = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.9, 1.3, 4.2),
    new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.5, metalness: 0.4 }),
    N,
  );
  const heads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.2, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfdfbe6, emissiveIntensity: 3.2 }),
    N * 2,
  );
  const tails = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.16, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a12, emissiveIntensity: 1.8 }),
    N * 2,
  );
  bodies.frustumCulled = false;
  heads.frustumCulled = false;
  tails.frustumCulled = false;
  scene.add(bodies, heads, tails);

  // Per-frame scratch (reused — NO allocation in update()).
  const pos = new THREE.Vector3();
  const wp = new THREE.Vector3();
  const off = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const ONE = new THREE.Vector3(1, 1, 1);

  const setLight = (mesh: THREE.InstancedMesh, idx: number, lx: number, lz: number): void => {
    off.set(lx, 0, lz).applyQuaternion(quat);
    wp.copy(pos).add(off);
    TMP_M.compose(wp, quat, ONE);
    mesh.setMatrixAt(idx, TMP_M);
  };

  function update(dt: number): void {
    for (let i = 0; i < N; i++) {
      const car = cars[i];
      if (!car) continue;
      car.s += car.dir * car.speed * dt;
      if (car.s > BAND_HI) car.s -= BAND;
      else if (car.s < BAND_LO) car.s += BAND;
      const place = placeOnCentreline(route, car.s, car.d);
      const baseY = anchorY(route, car.s, car.d, 0);
      euler.set(0, place.heading + (car.dir > 0 ? 0 : Math.PI), 0); // face travel
      quat.setFromEuler(euler);
      pos.set(place.x, baseY + 0.65, place.z);
      TMP_M.compose(pos, quat, ONE);
      bodies.setMatrixAt(i, TMP_M);
      // Headlights at the front (+Z local), tail-lights at the back (−Z local).
      setLight(heads, i * 2, -0.6, 2.05);
      setLight(heads, i * 2 + 1, 0.6, 2.05);
      setLight(tails, i * 2, -0.6, -2.05);
      setLight(tails, i * 2 + 1, 0.6, -2.05);
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    tails.instanceMatrix.needsUpdate = true;
  }

  update(0); // place cars at their seeded start before the first render
  return { update };
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
  // White base so per-instance instanceColor carries the true foliage tint — a
  // varied palette of greens (+ a couple yellow-green / autumn-brown) so the
  // woodland isn't one flat tone (R11 — the biggest "toy diorama" tell).
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const foliage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), foliageMat, N);
  const foliageTints = [0x3a6b2f, 0x2f5527, 0x4a7233, 0x586b2c, 0x6f5e34, 0x356048];
  const FOLIAGE_COL = new THREE.Color();
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
      // Per-instance squash/stretch so canopies aren't identical gems.
      const fx = fr * (0.78 + rnd() * 0.5);
      const fz = fr * (0.78 + rnd() * 0.5);
      TMP_M.compose(TMP_P.set(place.x, baseY + trunkH + fr * 0.7, place.z), NOROT, TMP_S.set(fx, fr * (1.0 + rnd() * 0.6), fz));
      foliage.setMatrixAt(placed, TMP_M);
      foliage.setColorAt(placed, FOLIAGE_COL.setHex(foliageTints[Math.floor(rnd() * foliageTints.length)] ?? 0x3a6b2f));
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
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
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
function buildBuildings(scene: THREE.Scene, route: Route, gauge: number): THREE.MeshStandardMaterial {
  const len = route.length;
  const rnd = makeRng(20260617);
  const N = 240;
  // Lit-window facade (HLD §2.A): one shared albedo + emissive map on the single
  // InstancedMesh (DL1). instanceColor tints the masonry per building. emissive
  // intensity is driven by scene.ts from nightFactor (lit at night, dark by day).
  const facade = buildFacade(4);
  const mat = new THREE.MeshStandardMaterial({
    map: facade.albedo,
    emissiveMap: facade.emissive,
    emissive: 0xffffff,
    emissiveIntensity: 0, // set per-frame from nightFactor in scene.ts
    roughness: 0.88,
  });
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  // Daylight masonry palette (brick / buff / stone / sandstone / pale render / brown)
  // so blocks read as inhabited buildings by day, not charcoal monoliths.
  const tints = [0xb08868, 0xc8b89a, 0xa8aab0, 0xbfa884, 0xc2c4c0, 0x9c8a72];
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
  return mat;
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
 * The hero moonlit steel through-truss (HLD §2.C): a road bridge crossing the
 * line, built as a Pratt-style lattice — bottom/top chords, verticals, alternating
 * diagonals, top lateral bracing and corner support legs — placed and rotated by
 * `placeOnCentreline`, with the deck soffit a loading-gauge clearance above
 * `formationHeight` (R4). The steel is high-metalness / low-roughness with raised
 * `envMapIntensity` so it catches the sky reflection, plus a faint self-glow and
 * cool emissive nav-lights at every top-chord node that rim-light the lattice
 * against the night. Every member is ONE InstancedMesh of scaled unit cylinders
 * (so the whole truss is ~3 draw calls, not ~50 separate meshes). Built ONCE.
 */
function buildTrussBridge(scene: THREE.Scene, route: Route, s: number): void {
  if (s < 0 || s > route.length) return;
  if (viaductSpanAt(route, s) || boreCorridorAt(route, s, 0)) return;

  const railTop = formationHeight(route, s);
  const bottomY = railTop + 6.2; // deck soffit clearance above the rail top (R4)
  const span = 22; // across the formation (local X)
  const th = 5.5; // truss height (bottom chord → top chord)
  const topY = bottomY + th;
  const panels = 7;
  const pw = span / panels;
  const half = span / 2;
  const zoff = 3.0; // half the road width (local Z, along the line)

  const place = placeOnCentreline(route, s, 0);
  const g = new THREE.Group();
  g.position.set(place.x, 0, place.z);
  g.quaternion.setFromAxisAngle(Y_AXIS, place.heading);

  // Collect every steel member as a {a, b, radius} bar (group-local coords).
  const bars: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
  const bar = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number,
  ): void => {
    bars.push({ a: new THREE.Vector3(ax, ay, az), b: new THREE.Vector3(bx, by, bz), r });
  };
  for (const zz of [-zoff, zoff]) {
    bar(-half, bottomY, zz, half, bottomY, zz, 0.16); // bottom chord
    bar(-half, topY, zz, half, topY, zz, 0.16); // top chord
    for (let i = 0; i <= panels; i++) {
      const x = -half + i * pw;
      bar(x, bottomY, zz, x, topY, zz, 0.09); // vertical
    }
    for (let i = 0; i < panels; i++) {
      const x0 = -half + i * pw;
      const x1 = x0 + pw;
      const up = i % 2 === 0;
      bar(x0, up ? bottomY : topY, zz, x1, up ? topY : bottomY, zz, 0.09); // diagonal
    }
    bar(-half, railTop, zz, -half, bottomY, zz, 0.18); // support leg (below the deck)
    bar(half, railTop, zz, half, bottomY, zz, 0.18);
  }
  for (let i = 0; i <= panels; i++) {
    const x = -half + i * pw;
    bar(x, topY, -zoff, x, topY, zoff, 0.07); // top lateral bracing
  }

  // Cool steel that reads at night: metallic so it catches the moon's specular
  // sheen + raised envMapIntensity for the sky reflection, plus a self-glow strong
  // enough that the lattice never collapses to a flat silhouette (AC-C).
  const steel = new THREE.MeshStandardMaterial({
    color: 0x46505f,
    metalness: 0.85,
    roughness: 0.34,
    envMapIntensity: 1.8,
    emissive: 0x2c3a4d,
    emissiveIntensity: 0.6,
  });
  const cyl = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 7), steel, bars.length);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  for (let i = 0; i < bars.length; i++) {
    const bdef = bars[i];
    if (!bdef) continue;
    dir.subVectors(bdef.b, bdef.a);
    const len = Math.max(0.01, dir.length());
    mid.addVectors(bdef.a, bdef.b).multiplyScalar(0.5);
    quat.setFromUnitVectors(Y_AXIS, dir.normalize());
    scl.set(bdef.r, len, bdef.r);
    TMP_M.compose(mid, quat, scl);
    cyl.setMatrixAt(i, TMP_M);
  }
  cyl.instanceMatrix.needsUpdate = true;
  cyl.frustumCulled = false;
  g.add(cyl);

  // Dark road deck spanning between the two trusses.
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(span, 0.4, zoff * 2),
    new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.9 }),
  );
  deck.position.set(0, bottomY, 0);
  g.add(deck);

  // Cool nav-lights at every top-chord node — they rim-light the lattice and trace
  // the truss line against the sky. ONE emissive InstancedMesh (no PointLight).
  const nodeMat = new THREE.MeshStandardMaterial({
    color: 0x223044,
    emissive: 0xc2d6ff,
    emissiveIntensity: 2.4,
  });
  const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 8), nodeMat, (panels + 1) * 2);
  let ni = 0;
  for (const zz of [-zoff, zoff]) {
    for (let i = 0; i <= panels; i++) {
      placeBox(nodes, ni++, -half + i * pw, topY, zz, 1, 1, 1);
    }
  }
  nodes.instanceMatrix.needsUpdate = true;
  nodes.frustumCulled = false;
  g.add(nodes);

  // Warm lamps strung along the deck edge — a lit road across the bridge that
  // contrasts the cool nav-lights. ONE emissive InstancedMesh (no PointLight).
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    emissive: 0xffe2b0,
    emissiveIntensity: 2.6,
  });
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 8, 8), lampMat, panels + 1);
  for (let i = 0; i <= panels; i++) {
    placeBox(lamps, i, -half + i * pw, bottomY + 0.5, zoff, 1, 1, 1);
  }
  lamps.instanceMatrix.needsUpdate = true;
  lamps.frustumCulled = false;
  g.add(lamps);

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
