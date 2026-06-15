import * as THREE from "three";
import type { ControlState, SafetyState } from "../sim/controls";
import { BRAKE_EMERGENCY, POWER_NOTCHES, penaltyActive } from "../sim/controls";
import type { AwsState } from "../sim/aws";
import type { Route, Station } from "../sim/route";
import { aspectAt } from "../sim/route";
import type { EnvironmentParams } from "../sim/environment";
import { createCab, type CabView } from "./cab";

const MPS_TO_MPH = 2.236936;

/** Everything the world + cab need to render one frame (HLD §2.1). */
export interface RenderView {
  chainage: number;
  speed: number;
  dt: number;
  controls: ControlState;
  safety: SafetyState;
  aws: AwsState;
  served: ReadonlySet<string>;
  /** Time-of-day × weather visual params (projected in main.ts). */
  env: EnvironmentParams;
}

export interface SceneHandle {
  /** Project sim state into the cab view and render the world under the
   *  current environment (wet-night is merely the default). */
  render(view: RenderView): void;
  resize(): void;
}

// Aspect → lamp emissive colour. DOUBLE_YELLOW lights both amber lamps.
const ASPECT_COLOUR = {
  RED: 0xff2418,
  YELLOW: 0xffb020,
  DOUBLE_YELLOW: 0xffb020,
  GREEN: 0x30ff60,
} as const;

// Rain box half-extents around the camera (m).
const RAIN_HALF_X = 18;
const RAIN_HALF_Y = 16;
const RAIN_HALF_Z = 40;
const RAIN_FALL = 22; // m/s downward
const RAIN_SLANT = 0.35; // forward slant fraction of fall

// Defaults preserving today's behaviour when no quality opts are supplied.
const DEFAULT_RAIN_COUNT = 2400;
const DEFAULT_PIXEL_RATIO_CAP = 2;

/** Quality knobs from the pure `qualityFor` tier (HLD §2.7). */
export interface SceneOptions {
  rainCount?: number; // rain particles to allocate (default 2400; 0 builds empty)
  pixelRatioCap?: number; // clamp on devicePixelRatio (default 2)
}

/**
 * Build the wet-night world + cab (HLD §2.3). The cab is created internally and
 * parented to the camera, so `main.ts` stays thin: it only assembles the
 * RenderView. Geometry/materials are created once; the per-frame loops
 * (rain/signals) allocate nothing.
 */
export function createScene(parent: HTMLElement, route: Route, opts?: SceneOptions): SceneHandle {
  const rainCount = opts?.rainCount ?? DEFAULT_RAIN_COUNT;
  const pixelRatioCap = opts?.pixelRatioCap ?? DEFAULT_PIXEL_RATIO_CAP;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  parent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080f);
  scene.fog = new THREE.Fog(0x05080f, 25, 260);

  const camera = new THREE.PerspectiveCamera(70, parent.clientWidth / parent.clientHeight, 0.05, 2000);

  // ── Lighting: deepened night (intensities driven by env each frame) ────────
  const hemi = new THREE.HemisphereLight(0x1a2636, 0x03040a, 0.35);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x8aa0c8, 0.4);
  moon.position.set(-40, 80, -20);
  scene.add(moon);

  // ── Ground ─────────────────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, route.length + 400),
    new THREE.MeshStandardMaterial({ color: 0x080c0a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = route.length / 2;
  scene.add(ground);

  // ── Wet rails (raised metalness / lowered roughness for sheen) ─────────────
  const gauge = 1.435;
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x4a5260,
    metalness: 0.95,
    roughness: 0.12,
  });
  for (const x of [-gauge / 2, gauge / 2]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, route.length), railMat);
    rail.position.set(x, 0.06, route.length / 2);
    scene.add(rail);
  }

  // ── Sleepers (one instanced mesh) ──────────────────────────────────────────
  const spacing = 0.65;
  const count = Math.floor(route.length / spacing);
  const sleepers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.6, 0.12, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 1 }),
    count,
  );
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    m.setPosition(0, 0.02, i * spacing);
    sleepers.setMatrixAt(i, m);
  }
  sleepers.instanceMatrix.needsUpdate = true;
  scene.add(sleepers);

  // ── 3D signal heads (one per route.signals[i]) ─────────────────────────────
  // Each head: a post + three lamp discs (red/amber/green) with an additive glow
  // halo. We keep references to each head's materials so the per-frame loop only
  // writes emissive intensities — no allocation.
  interface SignalHead {
    red: THREE.MeshStandardMaterial;
    amberTop: THREE.MeshStandardMaterial;
    amberBot: THREE.MeshStandardMaterial;
    green: THREE.MeshStandardMaterial;
    glow: THREE.Sprite;
  }
  const heads: SignalHead[] = [];
  const sideX = gauge / 2 + 2.2; // signal stands to the right of the track
  const lampGeo = new THREE.CircleGeometry(0.16, 16);
  const glowTex = makeGlowTexture();

  for (const sig of route.signals) {
    const head = new THREE.Group();
    head.position.set(sideX, 0, sig.chainage);
    // Post.
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, 4.2, 10),
      new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.8, metalness: 0.3 }),
    );
    post.position.y = 2.1;
    head.add(post);
    // Backboard.
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.5, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.9 }),
    );
    board.position.set(0, 4.0, 0);
    head.add(board);

    const mkLamp = (y: number, color: number): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x05070a,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0,
        roughness: 0.5,
      });
      const disc = new THREE.Mesh(lampGeo, mat);
      disc.position.set(0, y, -0.06); // face back toward an approaching (−Z) train
      disc.rotation.y = Math.PI;
      head.add(disc);
      return mat;
    };
    // Top→bottom: red, amber, amber, green (4-aspect head; DOUBLE_YELLOW = both ambers).
    const red = mkLamp(4.55, ASPECT_COLOUR.RED);
    const amberTop = mkLamp(4.2, ASPECT_COLOUR.YELLOW);
    const amberBot = mkLamp(3.85, ASPECT_COLOUR.YELLOW);
    const green = mkLamp(3.5, ASPECT_COLOUR.GREEN);

    // One additive glow sprite sitting over the head; its colour/opacity track
    // the lit aspect for the wet halo.
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.scale.set(2.4, 2.4, 1);
    glow.position.set(0, 4.0, -0.1);
    head.add(glow);

    scene.add(head);
    heads.push({ red, amberTop, amberBot, green, glow });
  }

  // ── Rain (one THREE.Points, scrolled + wrapped, no per-frame allocation) ───
  const rainPos = new Float32Array(rainCount * 3);
  for (let i = 0; i < rainCount; i++) {
    rainPos[i * 3 + 0] = (Math.random() * 2 - 1) * RAIN_HALF_X;
    rainPos[i * 3 + 1] = Math.random() * 2 * RAIN_HALF_Y; // 0..2H, wrapped about camera.y
    rainPos[i * 3 + 2] = (Math.random() * 2 - 1) * RAIN_HALF_Z;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.PointsMaterial({
    color: 0x9fb6d8,
    size: 0.06,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled = false;
  scene.add(rain);

  // ── Stations + lineside scenery (built once; instanced where it pays) ──────
  // Coordinate convention (HLD §2.2): world +Z = toward Eastbank (increasing
  // chainage); the camera sits at z = chainage − 0.6 looking toward +Z. Every
  // lineside/station object lives at z = its chainage, x = ±offset from the
  // track centre (x = 0), y ≥ 0 up. Nothing lands behind the camera.
  for (const station of route.stations) buildStation(scene, station, gauge);
  buildLineside(scene, route, gauge);

  // ── Cab (children of the camera) ───────────────────────────────────────────
  const cab = createCab(camera);
  scene.add(camera); // camera must be in the graph for its children to render

  const cabView: CabView = {
    powerFrac: 0,
    brakeFrac: 0,
    reverser: "OFF",
    speedMph: 0,
    sunflower: "BLACK",
    dra: false,
    dsd: false,
    penalty: false,
    wiperOn: true,
    dt: 0,
  };

  function updateSignals(view: RenderView): void {
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (!head) continue;
      const aspect = aspectAt(route, i, view.served);
      head.red.emissiveIntensity = aspect === "RED" ? 1.4 : 0;
      head.amberTop.emissiveIntensity = aspect === "YELLOW" || aspect === "DOUBLE_YELLOW" ? 1.3 : 0;
      head.amberBot.emissiveIntensity = aspect === "DOUBLE_YELLOW" ? 1.3 : 0;
      head.green.emissiveIntensity = aspect === "GREEN" ? 1.3 : 0;
      const glowMat = head.glow.material as THREE.SpriteMaterial;
      glowMat.color.setHex(ASPECT_COLOUR[aspect]);
      glowMat.opacity = 0.55;
    }
  }

  function updateRain(view: RenderView): void {
    const dt = view.dt;
    const camZ = view.chainage - 0.6;
    const fall = RAIN_FALL * dt;
    const slant = fall * RAIN_SLANT + Math.abs(view.speed) * dt * 0.25;
    const pos = rainGeo.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < rainCount; i++) {
      const yi = i * 3 + 1;
      const zi = i * 3 + 2;
      let y = arr[yi]! - fall; // fall relative to camera
      let z = arr[zi]! - slant; // and slant backward as the train pushes forward
      // Wrap into [0, 2H) in y and [−Hz, Hz) in z (about the camera).
      if (y < 0) y += 2 * RAIN_HALF_Y;
      if (z < -RAIN_HALF_Z) z += 2 * RAIN_HALF_Z;
      arr[yi] = y;
      arr[zi] = z;
    }
    pos.needsUpdate = true;
    // Anchor the whole cloud on the camera so it always surrounds the eye.
    rain.position.set(0, camera.position.y - RAIN_HALF_Y, camZ);
    rain.position.x = 0;
  }

  function render(view: RenderView): void {
    camera.position.set(0, 1.9, view.chainage - 0.6);
    camera.lookAt(0, 1.6, view.chainage + 30);

    // ── Apply the environment (sky/fog, lights, rain, rail sheen) ────────────
    const env = view.env;
    (scene.background as THREE.Color).setHex(env.skyColor);
    const fog = scene.fog as THREE.Fog;
    fog.color.setHex(env.skyColor);
    fog.near = env.fogNear;
    fog.far = env.fogFar;
    hemi.intensity = env.ambientIntensity;
    moon.intensity = env.moonIntensity;
    rainMat.opacity = env.rainIntensity;
    railMat.roughness = lerp(0.35, 0.08, env.railWetness);

    updateSignals(view);
    // Skip the rain scroll loop entirely when it isn't raining (perf).
    if (env.rainIntensity > 0) updateRain(view);

    // Project the cab view from sim state.
    const c = view.controls;
    cabView.powerFrac = c.powerNotch / POWER_NOTCHES;
    cabView.brakeFrac = c.brakeStep / BRAKE_EMERGENCY;
    cabView.reverser = c.reverser;
    cabView.speedMph = Math.abs(view.speed) * MPS_TO_MPH;
    cabView.sunflower = view.aws.sunflower;
    cabView.dra = c.dra;
    cabView.dsd = view.safety.dsdWarning;
    cabView.penalty = penaltyActive(view.safety);
    cabView.wiperOn = env.wiperOn;
    cabView.dt = view.dt;
    cab.update(cabView);

    renderer.render(scene, camera);
  }

  function resize(): void {
    const w = parent.clientWidth, h = parent.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { render, resize };
}

/** Scalar lerp (shared by render + scenery builders). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Build one station's structures at its chainage (HLD §2.2): a platform slab to
 * one side of the running line, a flat canopy on posts, a back wall, an emissive
 * name board, and ≤ 2 platform lamps (emissive disc + a low-range PointLight).
 * Built once. The platform sits on the +X side; length ≈ 2 × platformHalf.
 */
function buildStation(scene: THREE.Scene, station: Station, gauge: number): void {
  const z = station.chainage;
  const len = 2 * station.platformHalf;
  const platW = 3.0; // platform width, m
  const platH = 0.9; // platform height, m
  const innerX = gauge / 2 + 0.7; // platform edge just clear of the running rail
  const centreX = innerX + platW / 2; // platform centre on the +X side

  const group = new THREE.Group();
  group.position.set(0, 0, z);

  // Lighter than the lineside furniture so the platform reads against the dark
  // ground even in the wet-night (the signature, darkest setting).
  const concrete = new THREE.MeshStandardMaterial({ color: 0x52585f, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c333c, roughness: 0.85 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x2a313b, roughness: 0.6, metalness: 0.4 });

  // Platform slab.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(platW, platH, len), concrete);
  slab.position.set(centreX, platH / 2, 0);
  group.add(slab);

  // Back wall (behind the platform, away from the track).
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, len), wallMat);
  wall.position.set(centreX + platW / 2 - 0.1, platH + 1.3, 0);
  group.add(wall);

  // Canopy: a flat roof on three posts.
  const canopyY = platH + 3.0;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(platW, 0.12, len * 0.8), steelMat);
  canopy.position.set(centreX, canopyY, 0);
  group.add(canopy);
  const postGeo = new THREE.BoxGeometry(0.12, canopyY - platH, 0.12);
  for (const pz of [-len * 0.35, 0, len * 0.35]) {
    const post = new THREE.Mesh(postGeo, steelMat);
    post.position.set(centreX - platW / 2 + 0.3, platH + (canopyY - platH) / 2, pz);
    group.add(post);
  }

  // Emissive name board (lit blue sign), face toward the track (−X) so an
  // arriving train reads it. Bright enough to glow as a landmark in the dark.
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.5, 3.2),
    new THREE.MeshStandardMaterial({
      color: 0x0a1020,
      emissive: new THREE.Color(0x3168c0),
      emissiveIntensity: 2.0,
      roughness: 0.5,
    }),
  );
  board.position.set(innerX + 0.05, platH + 1.7, 0);
  group.add(board);

  // ≤ 2 platform lamps: a bright emissive disc + one PointLight each, ranged to
  // pool warm light onto the platform so the station reads as a lit landmark.
  const lampGeo = new THREE.CircleGeometry(0.12, 16);
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x101418,
    emissive: new THREE.Color(0xffe2b0),
    emissiveIntensity: 2.6,
    roughness: 0.5,
  });
  for (const lz of [-len * 0.3, len * 0.3]) {
    const disc = new THREE.Mesh(lampGeo, lampMat);
    disc.position.set(centreX, platH + 3.4, lz);
    disc.rotation.x = Math.PI / 2; // face down
    group.add(disc);
    // Strong, wide pool so the lit platform reads as a landmark even at speed in
    // the wet-night dark (the most reliable night-station cue is a warm pool).
    const light = new THREE.PointLight(0xffe2b0, 3.0, 24);
    light.position.set(centreX, platH + 3.3, lz);
    group.add(light);
  }

  scene.add(group);
}

/**
 * Build the lineside scenery (HLD §2.2), each class as ONE InstancedMesh built
 * once with no per-frame allocation: OLE/catenary masts (~45 m), lineside
 * fencing (both sides), a handful of distant building blocks set well back, and
 * mileposts (~500 m). All at z = chainage, x = ±offset, y ≥ 0.
 */
function buildLineside(scene: THREE.Scene, route: Route, gauge: number): void {
  const len = route.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const v = new THREE.Vector3();

  // ── OLE / catenary masts every ~45 m, alternating sides ──────────────────
  const mastSpacing = 45;
  const mastN = Math.max(1, Math.floor(len / mastSpacing));
  const mastX = gauge / 2 + 2.6;
  // Two instances per mast position (post + cantilever arm), packed into one mesh.
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x10141a, roughness: 0.7, metalness: 0.5 });
  const postGeo = new THREE.BoxGeometry(0.18, 6.5, 0.18);
  const masts = new THREE.InstancedMesh(postGeo, mastMat, mastN);
  const armGeo = new THREE.BoxGeometry(2.4, 0.12, 0.12);
  const arms = new THREE.InstancedMesh(armGeo, mastMat, mastN);
  for (let i = 0; i < mastN; i++) {
    const z = (i + 1) * mastSpacing;
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * mastX;
    m.compose(v.set(x, 3.25, z), q.set(0, 0, 0, 1), sc);
    masts.setMatrixAt(i, m);
    // Cantilever arm reaching in over the track at pantograph height.
    m.compose(v.set(x - side * 1.2, 6.0, z), q.set(0, 0, 0, 1), sc);
    arms.setMatrixAt(i, m);
  }
  masts.instanceMatrix.needsUpdate = true;
  arms.instanceMatrix.needsUpdate = true;
  scene.add(masts);
  scene.add(arms);

  // Contact wire: one long thin box per running line at pantograph height.
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.5, metalness: 0.6 });
  const wire = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, len), wireMat);
  wire.position.set(0, 5.9, len / 2);
  scene.add(wire);

  // ── Lineside fencing: instanced low posts both sides every ~6 m ──────────
  const fenceSpacing = 6;
  const fenceN = Math.max(1, Math.floor(len / fenceSpacing));
  const fenceX = gauge / 2 + 4.5;
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x0e1116, roughness: 0.9 });
  const fenceGeo = new THREE.BoxGeometry(0.06, 1.0, 0.06);
  const fence = new THREE.InstancedMesh(fenceGeo, fenceMat, fenceN * 2);
  let fi = 0;
  for (let i = 0; i < fenceN; i++) {
    const z = (i + 1) * fenceSpacing;
    for (const side of [-1, 1] as const) {
      m.compose(v.set(side * fenceX, 0.5, z), q.set(0, 0, 0, 1), sc);
      fence.setMatrixAt(fi++, m);
    }
  }
  fence.instanceMatrix.needsUpdate = true;
  scene.add(fence);

  // ── Distant schematic buildings: a handful of dark blocks set well back ──
  const blockMat = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 1 });
  const winMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    emissive: new THREE.Color(0xffd27a),
    emissiveIntensity: 0.5,
    roughness: 0.9,
  });
  const blockSpecs = [
    { z: 700, x: 70, w: 26, h: 22, d: 18 },
    { z: 1700, x: -85, w: 34, h: 30, d: 22 },
    { z: 2900, x: 60, w: 22, h: 40, d: 16 },
    { z: 3600, x: -70, w: 40, h: 18, d: 24 },
    { z: 4800, x: 90, w: 28, h: 26, d: 20 },
    { z: 5500, x: -60, w: 30, h: 34, d: 18 },
  ];
  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  const blocks = new THREE.InstancedMesh(blockGeo, blockMat, blockSpecs.length);
  const winGeo = new THREE.BoxGeometry(1, 1, 0.3);
  const windows = new THREE.InstancedMesh(winGeo, winMat, blockSpecs.length);
  for (let i = 0; i < blockSpecs.length; i++) {
    const b = blockSpecs[i];
    if (!b) continue;
    m.compose(v.set(b.x, b.h / 2, b.z), q.set(0, 0, 0, 1), sc.set(b.w, b.h, b.d));
    blocks.setMatrixAt(i, m);
    // One emissive window-strip slab on the track-facing face.
    const faceX = b.x + (b.x < 0 ? b.w / 2 : -b.w / 2);
    m.compose(v.set(faceX, b.h * 0.55, b.z), q.set(0, 0, 0, 1), sc.set(b.w * 0.6, b.h * 0.5, 1));
    windows.setMatrixAt(i, m);
  }
  blocks.instanceMatrix.needsUpdate = true;
  windows.instanceMatrix.needsUpdate = true;
  scene.add(blocks);
  scene.add(windows);

  // ── Mileposts every ~500 m: tiny instanced posts beside the line ─────────
  const postSpacing = 500;
  const postN = Math.max(1, Math.floor(len / postSpacing));
  const milepostX = gauge / 2 + 2.0;
  const milepostMat = new THREE.MeshStandardMaterial({ color: 0xb0b4ba, roughness: 0.8 });
  const milepostGeo = new THREE.BoxGeometry(0.1, 0.6, 0.1);
  const mileposts = new THREE.InstancedMesh(milepostGeo, milepostMat, postN);
  for (let i = 0; i < postN; i++) {
    const z = (i + 1) * postSpacing;
    m.compose(v.set(milepostX, 0.3, z), q.set(0, 0, 0, 1), sc.set(1, 1, 1));
    mileposts.setMatrixAt(i, m);
  }
  mileposts.instanceMatrix.needsUpdate = true;
  scene.add(mileposts);
}

/** A soft round additive glow texture for the signal halos (built once). */
function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
