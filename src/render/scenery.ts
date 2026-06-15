// Lineside scenery & terrain (impure Three.js, screenshot-verified). The start
// of a richer world: rolling hills on the horizon, clumps of trees, an overbridge
// across the line, sloped cutting/embankment banks, and a few people on the
// platforms. Everything is built ONCE from instanced/simple geometry with no
// per-frame allocation; it is static (the global env lighting does the rest).
//
// Coordinate convention (matches scene.ts): world +Z = chainage (forward),
// x = ±lateral from the track centre (x = 0), y ≥ 0 up.

import * as THREE from "three";
import type { Route } from "../sim/route";

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
const TMP_Q = new THREE.Quaternion();
const TMP_P = new THREE.Vector3();
const TMP_S = new THREE.Vector3();
const NOROT = new THREE.Quaternion();

/** Place instance `i` of `mesh` at a position/scale (no rotation). */
function placeBox(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  TMP_M.compose(TMP_P.set(x, y, z), NOROT, TMP_S.set(sx, sy, sz));
  mesh.setMatrixAt(i, TMP_M);
}

/** Build all scenery + terrain features under `scene`. */
export function buildScenery(scene: THREE.Scene, route: Route, gauge: number): void {
  buildHills(scene, route.length);
  buildTrees(scene, route.length, gauge);
  buildCuttingsAndEmbankments(scene, route.length, gauge);
  buildOverbridge(scene, gauge, 2300, 0x6b5747); // brick road overbridge
  buildOverbridge(scene, gauge, 5050, 0x53585f); // a concrete one further on
  buildPlatformPeople(scene, route, gauge);
}

/** Rolling hills on the horizon, both sides, well back so fog hazes them. */
function buildHills(scene: THREE.Scene, len: number): void {
  const rnd = makeRng(1337);
  const mat = new THREE.MeshStandardMaterial({ color: 0x47553a, roughness: 1 });
  const per = 26; // hills per side
  const hills = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 10), mat, per * 2);
  let i = 0;
  for (const side of [-1, 1] as const) {
    for (let k = 0; k < per; k++) {
      const z = (k + 0.5) * (len / per) + (rnd() - 0.5) * 120;
      const x = side * (230 + rnd() * 220);
      const r = 90 + rnd() * 120;
      const h = 40 + rnd() * 90;
      // A squashed cone reads as a smooth hill; sink the base below ground.
      TMP_M.compose(TMP_P.set(x, h / 2 - 8, z), NOROT, TMP_S.set(r, h, r));
      hills.setMatrixAt(i++, TMP_M);
    }
  }
  hills.instanceMatrix.needsUpdate = true;
  hills.frustumCulled = false;
  scene.add(hills);
}

/** Clumps of trees both sides: a trunk mesh + a foliage mesh, instanced. */
function buildTrees(scene: THREE.Scene, len: number, gauge: number): void {
  const rnd = makeRng(8675309);
  const N = 360;
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 1 });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.26, 1, 6), trunkMat, N);
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x33602f, roughness: 1, flatShading: true });
  const foliage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), foliageMat, N);
  const minX = gauge / 2 + 7; // clear of the track / fence
  let placed = 0;
  let guard = 0;
  while (placed < N && guard < N * 4) {
    guard++;
    // Clump: pick a clump centre, then jitter around it for a natural cluster.
    const cz = rnd() * len;
    const side = rnd() < 0.5 ? -1 : 1;
    const cx = side * (minX + rnd() * rnd() * 150);
    const clump = 3 + Math.floor(rnd() * 5);
    for (let c = 0; c < clump && placed < N; c++) {
      const z = cz + (rnd() - 0.5) * 28;
      const x = cx + (rnd() - 0.5) * 22;
      if (Math.abs(x) < minX || z < 0 || z > len) continue;
      const h = 4 + rnd() * 7; // tree height, m
      const trunkH = h * 0.45;
      placeBox(trunks, placed, x, trunkH / 2, z, 1, trunkH, 1);
      const fr = h * 0.42; // foliage radius
      // Slight per-tree colour variation via instance scale only (keep one mat);
      TMP_M.compose(TMP_P.set(x, trunkH + fr * 0.7, z), NOROT, TMP_S.set(fr, fr * 1.25, fr));
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
 * Vary the lineside profile: a CUTTING (grass banks rising on both sides, close
 * in) over one stretch and an EMBANKMENT (banks falling away from a raised
 * formation) over another. Built from long sloped boxes — a cheap stand-in for a
 * proper terrain heightfield (the next step).
 */
function buildCuttingsAndEmbankments(scene: THREE.Scene, len: number, gauge: number): void {
  const grass = new THREE.MeshStandardMaterial({ color: 0x55633c, roughness: 1, side: THREE.DoubleSide });
  const earth = new THREE.MeshStandardMaterial({ color: 0x5a4d36, roughness: 1, side: THREE.DoubleSide });

  // Cutting: z 700→1300, banks rise from the track shoulder up and outward.
  addBank(scene, grass, 700, 1300, gauge / 2 + 2.5, +1, +0.7); // right bank rises
  addBank(scene, grass, 700, 1300, -(gauge / 2 + 2.5), -1, +0.7); // left bank rises

  // Embankment: z 3300→4000, the formation is raised; banks fall away outward.
  addBank(scene, earth, 3300, 4000, gauge / 2 + 1.5, +1, -0.6); // right bank falls
  addBank(scene, earth, 3300, 4000, -(gauge / 2 + 1.5), -1, -0.6); // left bank falls
  void len;
}

/**
 * One long sloped bank running z0→z1 along the track, its inner edge at xInner.
 * `dir` (+1 right / −1 left) is the outward direction; `slope` > 0 rises outward
 * (cutting), < 0 falls outward (embankment). A single rotated box face.
 */
function addBank(
  scene: THREE.Scene,
  mat: THREE.MeshStandardMaterial,
  z0: number,
  z1: number,
  xInner: number,
  dir: 1 | -1,
  slope: number,
): void {
  const length = z1 - z0;
  const width = 14; // bank face width, m
  const geo = new THREE.PlaneGeometry(width, length);
  const bank = new THREE.Mesh(geo, mat);
  // Plane defaults to facing +Z (in XY); lay it down and tilt it as a bank.
  bank.rotation.x = -Math.PI / 2; // flat on the ground
  bank.rotation.y = dir * slope; // tilt across the track axis → sloped bank
  const rise = (width / 2) * Math.abs(slope) * (slope > 0 ? 1 : -1);
  bank.position.set(xInner + dir * (width / 2) * Math.cos(slope), Math.max(0.05, rise * 0.5 + 0.05), (z0 + z1) / 2);
  scene.add(bank);
}

/** A road overbridge crossing the line: deck, two abutments, parapets. */
function buildOverbridge(scene: THREE.Scene, gauge: number, z: number, color: number): void {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const span = 16; // total width across the formation, m
  const deckY = 6.2;
  const deckThick = 0.7;
  const g = new THREE.Group();
  g.position.set(0, 0, z);
  // Deck.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, deckThick, 4.5), mat);
  deck.position.set(0, deckY, 0);
  g.add(deck);
  // Parapets (low walls along both deck edges).
  for (const pz of [-2.0, 2.0]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(span, 1.0, 0.3), mat);
    wall.position.set(0, deckY + 0.85, pz);
    g.add(wall);
  }
  // Abutments either side of the track.
  for (const ax of [-(gauge / 2 + 4.5), gauge / 2 + 4.5]) {
    const ab = new THREE.Mesh(new THREE.BoxGeometry(3, deckY, 5), mat);
    ab.position.set(ax * 1.6, deckY / 2, 0);
    g.add(ab);
  }
  scene.add(g);
}

/** A few simple standing figures on each platform. */
function buildPlatformPeople(scene: THREE.Scene, route: Route, gauge: number): void {
  const rnd = makeRng(54321);
  const platformX = gauge / 2 + 0.7 + 1.0; // a little in from the platform edge
  const platTop = 0.9; // platform surface height
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
    const n = 4;
    for (let k = 0; k < n; k++) {
      const z = st.chainage + (rnd() - 0.5) * 2 * (st.platformHalf - 12);
      const x = platformX + (rnd() - 0.5) * 1.4;
      TMP_M.compose(TMP_P.set(x, platTop + 0.85, z), NOROT, TMP_S.set(1, 1, 1));
      bodies.setMatrixAt(i, TMP_M);
      const c = coats[k % coats.length] ?? 0x808080;
      bodies.setColorAt(i, col.setHex(c));
      TMP_M.compose(TMP_P.set(x, platTop + 1.55, z), NOROT, TMP_S.set(1, 1, 1));
      heads.setMatrixAt(i, TMP_M);
      i++;
    }
  }
  bodies.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  scene.add(bodies);
  scene.add(heads);
  void TMP_Q;
}
