import * as THREE from "three";
import type { ControlState, SafetyState } from "../sim/controls";
import { BRAKE_EMERGENCY, POWER_NOTCHES, penaltyActive } from "../sim/controls";
import type { AwsState } from "../sim/aws";
import type { Route } from "../sim/route";
import { aspectAt } from "../sim/route";
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
}

export interface SceneHandle {
  /** Project sim state into the wet-night cab view and render it. */
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

// Rain box half-extents around the camera (m) and particle count.
const RAIN_HALF_X = 18;
const RAIN_HALF_Y = 16;
const RAIN_HALF_Z = 40;
const RAIN_COUNT = 2400;
const RAIN_FALL = 22; // m/s downward
const RAIN_SLANT = 0.35; // forward slant fraction of fall

/**
 * Build the wet-night world + cab (HLD §2.3). The cab is created internally and
 * parented to the camera, so `main.ts` stays thin: it only assembles the
 * RenderView. Geometry/materials are created once; the per-frame loops
 * (rain/signals) allocate nothing.
 */
export function createScene(parent: HTMLElement, route: Route): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  parent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080f);
  scene.fog = new THREE.Fog(0x05080f, 25, 260);

  const camera = new THREE.PerspectiveCamera(70, parent.clientWidth / parent.clientHeight, 0.05, 2000);

  // ── Lighting: deepened night ───────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x1a2636, 0x03040a, 0.35));
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
  const rainPos = new Float32Array(RAIN_COUNT * 3);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPos[i * 3 + 0] = (Math.random() * 2 - 1) * RAIN_HALF_X;
    rainPos[i * 3 + 1] = Math.random() * 2 * RAIN_HALF_Y; // 0..2H, wrapped about camera.y
    rainPos[i * 3 + 2] = (Math.random() * 2 - 1) * RAIN_HALF_Z;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.Points(
    rainGeo,
    new THREE.PointsMaterial({
      color: 0x9fb6d8,
      size: 0.06,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  rain.frustumCulled = false;
  scene.add(rain);

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
    for (let i = 0; i < RAIN_COUNT; i++) {
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

    updateSignals(view);
    updateRain(view);

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
