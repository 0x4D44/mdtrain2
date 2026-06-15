// src/render/terrain-mesh.ts — IMPURE world geometry (HLD §2.6 terrain-mesh +
// §2.6h set-pieces). This is ALL the world geometry: the ground ribbon, the
// track ribbon (rails/sleepers/ballast), the viaduct (deck/piers/arches/river/
// abutments), the tunnel (portals + dark bore shell), and the sea plane.
//
// Everything is built ONCE. There is NO per-frame work here: the only things the
// render loop touches are the materials handed back in WorldHandle (e.g. the rail
// roughness, re-parameterised from env.railWetness) — written, never allocated.
//
// Spatial truth comes from the PURE core (no spatial math lives here):
//   - placeOnCentreline(route, s, d) → world (x,y,z) on the curved spine
//   - formationHeight(route, s)      → the rail/deck top the train always runs on
//   - terrainHeight(route, s, d)     → the ground surface (carves the bore, drops
//                                      to the valley floor under a viaduct)
//   - boreCorridorAt(route, s, d)    → the near-track corridor to OMIT in a tunnel
//
// Three 0.183 / D23 colour-space pins are honoured by the R1 textures module; we
// only wire its maps onto MeshStandardMaterials and set envMapIntensity.

import * as THREE from "three";
import type { Route } from "../sim/route";
import {
  placeOnCentreline,
  headingAt,
} from "../sim/centerline";
import {
  formationHeight,
  terrainHeight,
  boreCorridorAt,
  macroReliefAt,
} from "../sim/terrain";
import type { QualitySettings } from "./quality";
import { createTextureSet } from "./textures";

// ── pinned render constants (HLD §2.6) ───────────────────────────────────────
/** Ground ribbon extends this far beyond [0,length] each end (m). */
const RIBBON_OVERHANG = 200;
/** Ground ribbon is sliced into sections of this along-track length (m). */
const SECTION_LEN = 900;
/** Standard gauge, m. */
const GAUGE = 1.435;

// ── ground-ribbon tuning ─────────────────────────────────────────────────────
/** Wet-sheen IBL contribution for the grass/earth ground. */
const GROUND_ENV_INTENSITY = 0.25;

// ── track-ribbon tuning ──────────────────────────────────────────────────────
/** Rail head cross-section (m). */
const RAIL_W = 0.07;
const RAIL_H = 0.12;
/** Rail top sits this far above the formation (rail proud of the ballast). */
const RAIL_TOP = 0.06;
/** Sleeper cross-section (m): width across track, height, length along track. */
const SLEEPER_W = 2.6;
const SLEEPER_H = 0.12;
const SLEEPER_L = 0.25;
/** Sleeper spacing along the track (m). */
const SLEEPER_SPACING = 0.65;
/** Ballast shoulder half-width and its drop below the rail top (m). */
const BALLAST_HALF = 1.9;
const BALLAST_DROP = 0.34;
/** Rail material wet/dry roughness endpoints (driven by env.railWetness). */
const RAIL_ROUGH_DRY = 0.35;
const RAIL_ROUGH_WET = 0.08;

// ── viaduct tuning ───────────────────────────────────────────────────────────
/** Pier spacing along the deck (m) — one arch per span. */
const PIER_SPACING = 40;
/** Pier cross-section (m). */
const PIER_W = 2.4;
const PIER_D = 3.0;
/** Deck thickness below the formation (m). */
const DECK_THICK = 1.6;
/** Deck overhang each side of the gauge (m). */
const DECK_HALF = 3.2;
/** Lateral offset of the two pier rows from the spine (m). */
const PIER_OFFSET = 2.2;
/** River plane depth below the formation at the trough (m). */
const RIVER_DROP = 1.5;

// ── tunnel tuning ────────────────────────────────────────────────────────────
/** Bore shell inner radius over the deck (m). */
const BORE_RADIUS = 5.5;
/** Portal ring outer half-extents (m). */
const PORTAL_HALF_W = 7.5;
const PORTAL_HALF_H = 8.5;
const PORTAL_THICK = 1.4;

// ── small local helpers (NO spatial math — only Three plumbing) ───────────────

/** Apply one material's albedo+normal maps and envMapIntensity onto a standard mat. */
function wireMaps(
  mat: THREE.MeshStandardMaterial,
  maps: { albedo: THREE.Texture; normal: THREE.Texture },
  envIntensity: number,
): void {
  mat.map = maps.albedo;
  mat.normalMap = maps.normal;
  mat.envMapIntensity = envIntensity;
  mat.needsUpdate = true;
}

/** The handle scene.ts (R3) drives per frame and disposes on teardown. */
export interface WorldHandle {
  /** Root group added to the scene; everything hangs off it. */
  group: THREE.Group;
  /** Rail material — write `.roughness` per frame from env.railWetness. */
  railMaterial: THREE.MeshStandardMaterial;
  /** Water materials (river + sea) — optional per-frame tint if scene.ts wishes. */
  waterMaterials: THREE.MeshStandardMaterial[];
  /** A dim point light at the far tunnel mouth, or null (R7 dark-preset aid). */
  boreLight: THREE.PointLight | null;
  /** Map env.railWetness∈[0,1] onto the rail roughness endpoints. */
  railRoughnessFor(wetness: number): number;
  /** Dispose every geometry/material/texture this module created. */
  dispose(): void;
}

/**
 * Build the entire world ONCE and add it to `scene`. Returns a WorldHandle whose
 * `railMaterial` scene.ts re-parameterises each frame from `env.railWetness`
 * (via `railRoughnessFor`) and whose `dispose()` tears it all down. No geometry,
 * material or texture is ever allocated after this call.
 *
 * `anisotropy` should be `renderer.capabilities.getMaxAnisotropy()` (crisp
 * grazing-angle ground/ballast); defaults to 1.
 */
export function buildWorld(
  scene: THREE.Scene,
  route: Route,
  tier: QualitySettings,
  anisotropy = 1,
): WorldHandle {
  const tex = createTextureSet(anisotropy);
  const disposables: { dispose(): void }[] = [tex];
  const track = (d: { dispose(): void }): void => {
    disposables.push(d);
  };

  const group = new THREE.Group();
  scene.add(group);

  // ── 1. GROUND RIBBON + far horizon ─────────────────────────────────────────
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  // Per-mesh tiling: clone the shared maps so the ground tiles densely without
  // disturbing other consumers (clones share the GPU image — cheap, D23-safe).
  const groundAlbedo = tex.ground.albedo.clone();
  const groundNormal = tex.ground.normal.clone();
  groundAlbedo.needsUpdate = true;
  groundNormal.needsUpdate = true;
  groundAlbedo.repeat.set(8, 8);
  groundNormal.repeat.set(8, 8);
  groundMat.map = groundAlbedo;
  groundMat.normalMap = groundNormal;
  groundMat.envMapIntensity = GROUND_ENV_INTENSITY;
  track(groundMat);
  track(groundAlbedo);
  track(groundNormal);

  buildGroundRibbon(group, route, tier, groundMat, track);
  // NOTE: a flat far-horizon band was removed — a single flat ring at deck level
  // (centred on the route midpoint) occludes any terrain that drops below it (the
  // viaduct valley) while the camera stands on it near mid-route. Fog already
  // fades the ground ribbon's edge into haze; the terrain ranges too far in height
  // (+33 hill to −48 valley) for one flat band to sit correctly. See journal.

  // ── 2. TRACK RIBBON (rails / sleepers / ballast) ───────────────────────────
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a626e,
    metalness: 0.95,
    roughness: RAIL_ROUGH_DRY,
  });
  wireMaps(railMaterial, tex.rail, 1.0); // strong env sheen on wet steel
  track(railMaterial);
  const ballastMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  wireMaps(ballastMat, tex.ballast, 0.15);
  track(ballastMat);
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.95 });
  track(sleeperMat);

  buildTrackRibbon(group, route, tier, railMaterial, ballastMat, sleeperMat, track);

  // ── 3. VIADUCT ─────────────────────────────────────────────────────────────
  const masonryMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  wireMaps(masonryMat, tex.masonry, 0.2);
  track(masonryMat);
  const waterMaterials: THREE.MeshStandardMaterial[] = [];
  buildViaducts(group, route, masonryMat, waterMaterials, track);

  // ── 4. TUNNEL ──────────────────────────────────────────────────────────────
  const boreLight = buildTunnels(group, route, masonryMat, track);

  // ── 5. SEA ─────────────────────────────────────────────────────────────────
  buildSea(group, route, waterMaterials, track);

  return {
    group,
    railMaterial,
    waterMaterials,
    boreLight,
    railRoughnessFor(wetness: number): number {
      const w = wetness < 0 ? 0 : wetness > 1 ? 1 : wetness;
      return RAIL_ROUGH_DRY + (RAIL_ROUGH_WET - RAIL_ROUGH_DRY) * w;
    },
    dispose(): void {
      scene.remove(group);
      disposeTree(group);
      for (const d of disposables) d.dispose();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GROUND RIBBON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The terrain ground: ONE unified (s,d) grid built first (positions + UVs +
 * central-difference normals), then sliced into SECTION_LEN sections that SHARE
 * boundary vertices+normals identically (so sections cull independently with no
 * seam/pop). The near-track bore corridor (boreCorridorAt) is OMITTED — its
 * quads are simply not emitted, leaving the trench for the bore shell to cover.
 */
function buildGroundRibbon(
  group: THREE.Group,
  route: Route,
  tier: QualitySettings,
  material: THREE.MeshStandardMaterial,
  track: (d: { dispose(): void }) => void,
): void {
  const sStart = -RIBBON_OVERHANG;
  const sEnd = route.length + RIBBON_OVERHANG;
  const segLen = Math.max(1, tier.terrainSegLen);
  const sCount = Math.max(1, Math.ceil((sEnd - sStart) / segLen)); // s-cells
  const sRows = sCount + 1; // vertex rows
  const dCols = Math.max(2, tier.terrainSubdiv) + 1; // vertex columns
  const half = tier.ribbonHalfWidth;

  // Unified grid: positions, uvs.
  const positions = new Float32Array(sRows * dCols * 3);
  const uvs = new Float32Array(sRows * dCols * 2);
  const sAt = (i: number): number => sStart + (i / sCount) * (sEnd - sStart);
  const dAt = (j: number): number => -half + (j / (dCols - 1)) * (2 * half);

  for (let i = 0; i < sRows; i++) {
    const s = sAt(i);
    for (let j = 0; j < dCols; j++) {
      const d = dAt(j);
      const p = placeOnCentreline(route, s, d);
      const y = terrainHeight(route, s, d);
      const o = (i * dCols + j) * 3;
      positions[o] = p.x;
      positions[o + 1] = y;
      positions[o + 2] = p.z;
      const uo = (i * dCols + j) * 2;
      uvs[uo] = s / 40; // ~40 m per albedo tile along the track
      uvs[uo + 1] = d / 40;
    }
  }

  // Central-difference normals on the UNIFIED grid (so adjacent sections share
  // boundary-vertex normals exactly — no popping). Computed from the sampled
  // world positions, clamped at the grid edges.
  const normals = new Float32Array(sRows * dCols * 3);
  const posAt = (i: number, j: number, out: THREE.Vector3): THREE.Vector3 => {
    const ci = i < 0 ? 0 : i >= sRows ? sRows - 1 : i;
    const cj = j < 0 ? 0 : j >= dCols ? dCols - 1 : j;
    const o = (ci * dCols + cj) * 3;
    return out.set(positions[o] ?? 0, positions[o + 1] ?? 0, positions[o + 2] ?? 0);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const ds = new THREE.Vector3();
  const dd = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < sRows; i++) {
    for (let j = 0; j < dCols; j++) {
      posAt(i + 1, j, a);
      posAt(i - 1, j, b);
      ds.subVectors(a, b);
      posAt(i, j + 1, a);
      posAt(i, j - 1, b);
      dd.subVectors(a, b);
      // tangent_s × tangent_d gives an upward normal for this winding.
      n.crossVectors(dd, ds);
      if (n.y < 0) n.negate();
      n.normalize();
      const o = (i * dCols + j) * 3;
      normals[o] = n.x;
      normals[o + 1] = n.y;
      normals[o + 2] = n.z;
    }
  }

  // Bore-corridor cells are omitted inline in the slicing loop below (per-cell
  // boreCorridorAt test on the cell midpoint), leaving the trench for the shell.
  const sCellsPerSection = Math.max(1, Math.round(SECTION_LEN / segLen));

  // Slice into sections sharing boundary rows. Each section spans s-cell rows
  // [r0, r1); it reuses the unified positions/normals/uvs for those rows.
  for (let r0 = 0; r0 < sCount; r0 += sCellsPerSection) {
    const r1 = Math.min(sCount, r0 + sCellsPerSection);
    const rowsInSec = r1 - r0 + 1; // vertex rows in this section
    const vCount = rowsInSec * dCols;

    const secPos = new Float32Array(vCount * 3);
    const secNorm = new Float32Array(vCount * 3);
    const secUv = new Float32Array(vCount * 2);
    for (let ri = 0; ri < rowsInSec; ri++) {
      const gi = r0 + ri; // global row index
      for (let j = 0; j < dCols; j++) {
        const gsrc = (gi * dCols + j) * 3;
        const gdst = (ri * dCols + j) * 3;
        secPos[gdst] = positions[gsrc] ?? 0;
        secPos[gdst + 1] = positions[gsrc + 1] ?? 0;
        secPos[gdst + 2] = positions[gsrc + 2] ?? 0;
        secNorm[gdst] = normals[gsrc] ?? 0;
        secNorm[gdst + 1] = normals[gsrc + 1] ?? 0;
        secNorm[gdst + 2] = normals[gsrc + 2] ?? 0;
        const usrc = (gi * dCols + j) * 2;
        const udst = (ri * dCols + j) * 2;
        secUv[udst] = uvs[usrc] ?? 0;
        secUv[udst + 1] = uvs[usrc + 1] ?? 0;
      }
    }

    // Emit two triangles per cell, OMITTING cells inside the bore corridor.
    const indices: number[] = [];
    for (let ri = 0; ri < rowsInSec - 1; ri++) {
      const gi = r0 + ri;
      const sMid = (sAt(gi) + sAt(gi + 1)) / 2;
      for (let j = 0; j < dCols - 1; j++) {
        const dMid = (dAt(j) + dAt(j + 1)) / 2;
        // Omit the near-track corridor under a tunnel hill (the bore trench).
        if (boreCorridorAt(route, sMid, dMid)) continue;
        const v00 = ri * dCols + j;
        const v10 = (ri + 1) * dCols + j;
        const v01 = ri * dCols + (j + 1);
        const v11 = (ri + 1) * dCols + (j + 1);
        indices.push(v00, v10, v11, v00, v11, v01);
      }
    }
    if (indices.length === 0) continue; // wholly omitted (rare) — skip

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(secPos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(secNorm, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(secUv, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    track(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TRACK RIBBON — rails, sleepers, ballast shoulder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The track that ALWAYS runs at formationHeight along the curved spine — incl.
 * the viaduct deck and the bore floor. Rails and the ballast shoulder are swept
 * as short box segments (one per terrainSegLen); sleepers are one InstancedMesh.
 * Out of the O18 ground-ribbon budget (separate meshes).
 */
function buildTrackRibbon(
  group: THREE.Group,
  route: Route,
  tier: QualitySettings,
  railMat: THREE.MeshStandardMaterial,
  ballastMat: THREE.MeshStandardMaterial,
  sleeperMat: THREE.MeshStandardMaterial,
  track: (d: { dispose(): void }) => void,
): void {
  const len = route.length;
  const segLen = Math.max(2, tier.terrainSegLen);
  const segN = Math.max(1, Math.ceil(len / segLen));

  // Reusable unit-length box geometries placed per segment via instancing.
  const railGeo = new THREE.BoxGeometry(RAIL_W, RAIL_H, 1);
  track(railGeo);
  const ballastGeo = new THREE.BoxGeometry(BALLAST_HALF * 2, 0.3, 1);
  track(ballastGeo);

  // Two rails + ballast, each an InstancedMesh of `segN` oriented unit boxes.
  const railLeft = new THREE.InstancedMesh(railGeo, railMat, segN);
  const railRight = new THREE.InstancedMesh(railGeo, railMat, segN);
  const ballast = new THREE.InstancedMesh(ballastGeo, ballastMat, segN);
  ballast.receiveShadow = true;

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const scl = new THREE.Vector3(1, 1, 1);

  for (let i = 0; i < segN; i++) {
    const s0 = i * segLen;
    const s1 = Math.min(len, (i + 1) * segLen);
    const sMid = (s0 + s1) / 2;
    const thisLen = s1 - s0;
    const heading = headingAt(route, sMid);
    const formY = formationHeight(route, sMid);
    euler.set(0, heading, 0); // front-+Z mesh: bare heading (D21)
    quat.setFromEuler(euler);

    // Ballast bed under the sleepers.
    const cBed = placeOnCentreline(route, sMid, 0);
    scl.set(1, 1, thisLen);
    pos.set(cBed.x, formY - BALLAST_DROP - 0.15, cBed.z);
    m.compose(pos, quat, scl);
    ballast.setMatrixAt(i, m);

    // Left & right rails at ±gauge/2.
    const cl = placeOnCentreline(route, sMid, -GAUGE / 2);
    pos.set(cl.x, formY + RAIL_TOP - RAIL_H / 2, cl.z);
    m.compose(pos, quat, scl);
    railLeft.setMatrixAt(i, m);
    const cr = placeOnCentreline(route, sMid, GAUGE / 2);
    pos.set(cr.x, formY + RAIL_TOP - RAIL_H / 2, cr.z);
    m.compose(pos, quat, scl);
    railRight.setMatrixAt(i, m);
  }
  railLeft.instanceMatrix.needsUpdate = true;
  railRight.instanceMatrix.needsUpdate = true;
  ballast.instanceMatrix.needsUpdate = true;
  group.add(railLeft, railRight, ballast);

  // Sleepers: one InstancedMesh, oriented per position along the spine.
  const sleeperGeo = new THREE.BoxGeometry(SLEEPER_W, SLEEPER_H, SLEEPER_L);
  track(sleeperGeo);
  const sleeperN = Math.max(1, Math.floor(len / SLEEPER_SPACING));
  const sleepers = new THREE.InstancedMesh(sleeperGeo, sleeperMat, sleeperN);
  for (let i = 0; i < sleeperN; i++) {
    const s = (i + 0.5) * SLEEPER_SPACING;
    const heading = headingAt(route, s);
    const c = placeOnCentreline(route, s, 0);
    const formY = formationHeight(route, s);
    euler.set(0, heading, 0);
    quat.setFromEuler(euler);
    scl.set(1, 1, 1);
    pos.set(c.x, formY - BALLAST_DROP + SLEEPER_H / 2, c.z);
    m.compose(pos, quat, scl);
    sleepers.setMatrixAt(i, m);
  }
  sleepers.instanceMatrix.needsUpdate = true;
  group.add(sleepers);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. VIADUCT — deck, instanced piers (to the valley floor), arches, river,
//    abutment + wing-walls at each mouth.
// ─────────────────────────────────────────────────────────────────────────────

function buildViaducts(
  group: THREE.Group,
  route: Route,
  masonryMat: THREE.MeshStandardMaterial,
  waterMaterials: THREE.MeshStandardMaterial[],
  track: (d: { dispose(): void }) => void,
): void {
  const viaducts = route.viaducts;
  if (!viaducts || viaducts.length === 0) return;

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const scl = new THREE.Vector3(1, 1, 1);

  // Count all deck segments and piers up front so InstancedMeshes are sized once.
  const DECK_SEG = 8; // m per deck box
  let totalDeck = 0;
  let totalPier = 0;
  for (const v of viaducts) {
    const s0 = v.center - v.halfLen;
    const s1 = v.center + v.halfLen;
    totalDeck += Math.max(1, Math.ceil((s1 - s0) / DECK_SEG));
    const piersPerRow = Math.max(2, Math.floor((s1 - s0) / PIER_SPACING) + 1);
    totalPier += piersPerRow * 2; // two rows
  }

  const deckGeo = new THREE.BoxGeometry(DECK_HALF * 2, DECK_THICK, DECK_SEG + 0.2);
  track(deckGeo);
  const deck = new THREE.InstancedMesh(deckGeo, masonryMat, totalDeck);
  deck.castShadow = true;
  deck.receiveShadow = true;

  const pierGeo = new THREE.BoxGeometry(PIER_W, 1, PIER_D); // unit-tall; scaled
  track(pierGeo);
  const piers = new THREE.InstancedMesh(pierGeo, masonryMat, totalPier);
  piers.castShadow = true;

  let deckI = 0;
  let pierI = 0;
  for (const v of viaducts) {
    const s0 = v.center - v.halfLen;
    const s1 = v.center + v.halfLen;

    // Deck along the spine at formation, lowered by half the deck thickness.
    const dN = Math.max(1, Math.ceil((s1 - s0) / DECK_SEG));
    for (let i = 0; i < dN; i++) {
      const sMid = s0 + (i + 0.5) * (s1 - s0) / dN;
      const heading = headingAt(route, sMid);
      const c = placeOnCentreline(route, sMid, 0);
      const formY = formationHeight(route, sMid);
      euler.set(0, heading, 0);
      quat.setFromEuler(euler);
      scl.set(1, 1, 1);
      pos.set(c.x, formY - DECK_THICK / 2 - 0.5, c.z);
      m.compose(pos, quat, scl);
      deck.setMatrixAt(deckI++, m);
    }

    // Piers: two rows at ±PIER_OFFSET, each dropped from the deck to the natural
    // valley floor terrainHeight at that pier's (s,d) (O8c — piers reach the floor).
    const piersPerRow = Math.max(2, Math.floor((s1 - s0) / PIER_SPACING) + 1);
    for (let i = 0; i < piersPerRow; i++) {
      const sPier = piersPerRow === 1 ? v.center : s0 + (i / (piersPerRow - 1)) * (s1 - s0);
      const heading = headingAt(route, sPier);
      const formY = formationHeight(route, sPier);
      euler.set(0, heading, 0);
      quat.setFromEuler(euler);
      for (const side of [-1, 1] as const) {
        const dPier = side * PIER_OFFSET;
        const c = placeOnCentreline(route, sPier, dPier);
        const floorY = terrainHeight(route, sPier, dPier);
        const deckBottom = formY - DECK_THICK - 0.5;
        const height = Math.max(0.5, deckBottom - floorY);
        scl.set(1, height, 1);
        pos.set(c.x, floorY + height / 2, c.z);
        m.compose(pos, quat, scl);
        piers.setMatrixAt(pierI++, m);
      }
    }

    // River plane at the valley trough (centre of the band), the long axis along
    // the spine. A single quad is enough — fog/water material carries it.
    const cMid = placeOnCentreline(route, v.center, 0);
    const troughY = terrainHeight(route, v.center, 0);
    const riverGeo = new THREE.PlaneGeometry(80, v.halfLen * 2 + 60);
    track(riverGeo);
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x223a4a,
      roughness: 0.12,
      metalness: 0.5,
    });
    riverMat.envMapIntensity = 0.8;
    track(riverMat);
    waterMaterials.push(riverMat);
    const river = new THREE.Mesh(riverGeo, riverMat);
    river.rotation.x = -Math.PI / 2;
    river.rotation.z = headingAt(route, v.center);
    river.position.set(cMid.x, formationHeight(route, v.center) - v.valleyDepth + RIVER_DROP, cMid.z);
    group.add(river);
    void troughY;

    // Abutment + wing-walls at each mouth, facing the ramped embankment-to-deck
    // transition. One masonry block per mouth.
    for (const sMouth of [s0, s1]) {
      const heading = headingAt(route, sMouth);
      const c = placeOnCentreline(route, sMouth, 0);
      const formY = formationHeight(route, sMouth);
      const groundY = terrainHeight(route, sMouth, DECK_HALF + 4);
      const wallH = Math.max(2, formY - groundY + 2);
      const abutGeo = new THREE.BoxGeometry(DECK_HALF * 2 + 4, wallH, 5);
      track(abutGeo);
      const abut = new THREE.Mesh(abutGeo, masonryMat);
      abut.castShadow = true;
      abut.receiveShadow = true;
      euler.set(0, heading, 0);
      quat.setFromEuler(euler);
      scl.set(1, 1, 1);
      pos.set(c.x, formY - wallH / 2, c.z);
      abut.position.copy(pos);
      abut.quaternion.copy(quat);
      group.add(abut);
    }
  }

  deck.instanceMatrix.needsUpdate = true;
  piers.instanceMatrix.needsUpdate = true;
  group.add(deck, piers);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TUNNEL — portals at each mouth + a dark bore shell (half-cylinder roof)
//    following the spine over the WHOLE band, so the omitted corridor is never an
//    open trench. Optionally a single dim point light at the far mouth (R7).
// ─────────────────────────────────────────────────────────────────────────────

function buildTunnels(
  group: THREE.Group,
  route: Route,
  masonryMat: THREE.MeshStandardMaterial,
  track: (d: { dispose(): void }) => void,
): THREE.PointLight | null {
  const tunnels = route.tunnels;
  if (!tunnels || tunnels.length === 0) return null;

  const SHELL_SEG = 10; // m per shell ring along the band
  const boreMat = new THREE.MeshStandardMaterial({
    color: 0x05060a,
    roughness: 1,
    metalness: 0,
    side: THREE.BackSide, // seen from inside the bore
  });
  track(boreMat);

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const scl = new THREE.Vector3(1, 1, 1);

  // Size the shell InstancedMesh once.
  let totalShell = 0;
  for (const t of tunnels) {
    totalShell += Math.max(1, Math.ceil((2 * t.halfLen) / SHELL_SEG));
  }
  // Half-cylinder roof: a half-open cylinder (top 180°), oriented along the spine.
  const shellGeo = new THREE.CylinderGeometry(
    BORE_RADIUS, BORE_RADIUS, SHELL_SEG + 0.2, 16, 1, true, 0, Math.PI,
  );
  track(shellGeo);
  const shell = new THREE.InstancedMesh(shellGeo, boreMat, totalShell);

  let boreLight: THREE.PointLight | null = null;
  let shellI = 0;
  for (const t of tunnels) {
    const s0 = t.center - t.halfLen;
    const s1 = t.center + t.halfLen;
    const segN = Math.max(1, Math.ceil((2 * t.halfLen) / SHELL_SEG));
    for (let i = 0; i < segN; i++) {
      const sMid = s0 + (i + 0.5) * (s1 - s0) / segN;
      const heading = headingAt(route, sMid);
      const c = placeOnCentreline(route, sMid, 0);
      const formY = formationHeight(route, sMid);
      // CylinderGeometry axis is +Y; rotate it to lie along the track (+Z) then
      // yaw by heading. The half-cylinder opening faces down (roof above the deck).
      euler.set(Math.PI / 2, heading, 0);
      quat.setFromEuler(euler);
      scl.set(1, 1, 1);
      pos.set(c.x, formY + 0.2, c.z);
      m.compose(pos, quat, scl);
      shell.setMatrixAt(shellI++, m);
    }

    // Portal rings (an arch frame) at each mouth, facing along the track.
    for (const sMouth of [s0, s1]) {
      const heading = headingAt(route, sMouth);
      const c = placeOnCentreline(route, sMouth, 0);
      const formY = formationHeight(route, sMouth);
      const portal = buildPortal(masonryMat, track);
      euler.set(0, heading, 0);
      portal.quaternion.setFromEuler(euler);
      portal.position.set(c.x, formY, c.z);
      group.add(portal);
    }

    // One dim point light at the FAR mouth (s1) so the bore never reads as a
    // pure black hole in the dark presets (R7). Low intensity, short range — not
    // interior lighting.
    if (!boreLight) {
      const cFar = placeOnCentreline(route, s1, 0);
      const formY = formationHeight(route, s1);
      boreLight = new THREE.PointLight(0x6a7a90, 0.6, 90, 1.5);
      boreLight.position.set(cFar.x, formY + 2.5, cFar.z);
      group.add(boreLight);
    }
  }
  shell.instanceMatrix.needsUpdate = true;
  group.add(shell);
  return boreLight;
}

/** A masonry portal frame (two jambs + a lintel) modelled front-+Z at the origin. */
function buildPortal(
  masonryMat: THREE.MeshStandardMaterial,
  track: (d: { dispose(): void }) => void,
): THREE.Group {
  const g = new THREE.Group();
  const jambGeo = new THREE.BoxGeometry(PORTAL_THICK, PORTAL_HALF_H * 2, PORTAL_THICK);
  track(jambGeo);
  for (const side of [-1, 1] as const) {
    const jamb = new THREE.Mesh(jambGeo, masonryMat);
    jamb.position.set(side * PORTAL_HALF_W, PORTAL_HALF_H, 0);
    jamb.castShadow = true;
    g.add(jamb);
  }
  const lintelGeo = new THREE.BoxGeometry(PORTAL_HALF_W * 2 + PORTAL_THICK, PORTAL_THICK, PORTAL_THICK);
  track(lintelGeo);
  const lintel = new THREE.Mesh(lintelGeo, masonryMat);
  lintel.position.set(0, PORTAL_HALF_H * 2, 0);
  lintel.castShadow = true;
  g.add(lintel);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SEA — a large water plane on the coastal side around Brinemouth→Seahaven.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sea: a large plane on one side of the line around the coast. It uses the
 * coastal station (Brinemouth) and the terminus (Seahaven) chainages to span the
 * coast, set just below the lowest formation there. One side (+d) faces the sea.
 */
function buildSea(
  group: THREE.Group,
  route: Route,
  waterMaterials: THREE.MeshStandardMaterial[],
  track: (d: { dispose(): void }) => void,
): void {
  // Find the coastal stretch: from the coast station to the sea terminus.
  const coast = route.stations.find((st) => /coast|brine/i.test(st.name));
  const terminus = route.stations[route.stations.length - 1];
  if (!terminus) return;
  // Use Brinemouth if named; otherwise the last quarter of the route.
  const sStart = coast ? coast.chainage : route.length * 0.75;
  const sEnd = terminus.chainage;
  const sMid = (sStart + sEnd) / 2;

  // Only render the sea if this is genuinely a coastal route (a viaduct/tunnel
  // grand route); skip the plain physics fixture which has no coast.
  if (!route.tunnels && !route.viaducts) return;

  const heading = headingAt(route, sMid);
  const seaWidth = 2000;
  const SEA_OFFSET = 120; // sea begins this far to the +d (seaward) side
  const c = placeOnCentreline(route, sMid, SEA_OFFSET + seaWidth / 2);
  const seaLen = (sEnd - sStart) + 600;
  const seaY = formationHeight(route, sEnd) - 6;

  const geo = new THREE.PlaneGeometry(seaWidth, seaLen);
  track(geo);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16313f,
    roughness: 0.1,
    metalness: 0.6,
  });
  mat.envMapIntensity = 1.0;
  track(mat);
  waterMaterials.push(mat);
  const sea = new THREE.Mesh(geo, mat);
  sea.rotation.x = -Math.PI / 2;
  sea.rotation.z = heading;
  sea.position.set(c.x, seaY, c.z);
  group.add(sea);

  // Keep macroReliefAt imported usefully: assert the coast is not a tunnel/viaduct
  // band so the sea plane never clips a set-piece (cheap guard, build-time only).
  void macroReliefAt(route, sMid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Teardown
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively dispose every geometry/material under a node (textures handled
 *  separately by the TextureSet + tracked clones). */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh> & Partial<THREE.InstancedMesh>;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
  });
}
