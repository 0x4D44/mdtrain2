// The driver's-eye cab interior (HLD §2.2) — impure, screenshot-verified.
//
// Built once from primitive geometry (no external assets) as CHILDREN of the
// camera, so the whole cab moves with the view and renders as the foreground.
// `update(view)` rotates the levers/needle/wiper and swaps lamp/sunflower
// materials. No sim logic lives here: it consumes a small projection (`CabView`)
// that scene.ts builds from the per-frame RenderView. Verified by build +
// screenshot, not unit tests.

import * as THREE from "three";

/** The small projection the cab needs each frame (built in scene.ts). */
export interface CabView {
  /** 0..1 power demand (notch / POWER_NOTCHES). */
  powerFrac: number;
  /** 0..1 brake demand (brakeStep / BRAKE_EMERGENCY). */
  brakeFrac: number;
  /** Reverser position for the small reverser handle. */
  reverser: "FWD" | "OFF" | "REV";
  /** Road speed, mph (drives the speedo needle). */
  speedMph: number;
  /** AWS sunflower: BLACK (clear) or CAUTION (black/yellow). */
  sunflower: "BLACK" | "CAUTION";
  /** Indicator lamps. */
  dra: boolean;
  dsd: boolean;
  penalty: boolean;
  /** Wiper gate: sweeps when true; eases to park and stops when false. */
  wiperOn: boolean;
  /** Frame delta, s — advances the wiper sweep. */
  dt: number;
}

export interface CabHandle {
  update(view: CabView): void;
}

// Speedo: full-scale ~120 mph swept across ~240° of needle travel.
const SPEEDO_FULL_MPH = 120;
const SPEEDO_SWEEP = (240 * Math.PI) / 180; // radians for 0..full
const SPEEDO_ZERO = (120 * Math.PI) / 180; // needle angle at 0 mph (points down-left)

// Lever travel: vertical-ish handles pivoting toward/away from the driver.
const LEVER_BACK = -0.5; // rad, fully off / released (leaning back)
const LEVER_FWD = 0.55; // rad, fully applied (leaning forward)

// Wiper sweep.
const WIPER_RATE = 3.2; // rad/s of phase accumulation (≈ one beat / sweep)
const WIPER_AMP = (52 * Math.PI) / 180; // half-sweep amplitude
const WIPER_CENTRE = (-12 * Math.PI) / 180; // park slightly off-centre

/**
 * Build the cab as children of `camera`. Returns an `update` that binds the
 * meshes to a CabView each frame. Geometry/materials are created once.
 */
export function createCab(camera: THREE.Camera): CabHandle {
  const root = new THREE.Group();
  // Sit the cab furniture below/around the eye. A Three.js camera looks down its
  // local −Z, so the cab sits at −Z (in front) and −Y (below) the eye.
  camera.add(root);
  // A dim, short-range cab light so the dark night furniture reads (without
  // flooding the wet-night world — range is a couple of metres).
  const cabLight = new THREE.PointLight(0xffe8c8, 0.9, 3.2);
  cabLight.position.set(0, 0.15, -0.35);
  camera.add(cabLight);

  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.7, metalness: 0.3 });
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x1b2028, roughness: 0.6, metalness: 0.25 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.8, metalness: 0.2 });

  // ── Windscreen surround (a frame around the forward view) ──────────────────
  // Four thin bars forming a rectangle ahead of the eye.
  const frameZ = -0.9;
  const barMat = trimMat;
  const halfW = 0.95, halfH = 0.62, bar = 0.06;
  const mkBar = (w: number, h: number, x: number, y: number): THREE.Mesh => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, bar), barMat);
    b.position.set(x, y, frameZ);
    return b;
  };
  root.add(mkBar(2 * halfW + bar, bar, 0, halfH)); // top
  root.add(mkBar(2 * halfW + bar, bar, 0, -halfH)); // bottom
  root.add(mkBar(bar, 2 * halfH, -halfW, 0)); // left
  root.add(mkBar(bar, 2 * halfH, halfW, 0)); // right
  // Centre pillar.
  root.add(mkBar(bar, 2 * halfH, 0, 0));

  // ── Desk slab ──────────────────────────────────────────────────────────────
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.55), deskMat);
  desk.position.set(0, -0.62, -0.78);
  desk.rotation.x = -0.18; // slight rake toward the driver
  root.add(desk);

  // ── Lever factory (pivots about its base near the desk top) ────────────────
  function makeLever(x: number, knobColor: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, -0.58, -0.7);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.26, 12), darkMetal);
    shaft.position.y = 0.13; // base at group origin, extends up
    g.add(shaft);
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 12),
      new THREE.MeshStandardMaterial({ color: knobColor, roughness: 0.5, metalness: 0.2 }),
    );
    knob.position.y = 0.27;
    g.add(knob);
    root.add(g);
    return g;
  }
  const powerLever = makeLever(-0.42, 0x3a6a3a); // green-ish power handle
  const brakeLever = makeLever(0.42, 0x6a3030); // red-ish brake handle

  // Small reverser handle (short stub, swings between three detents).
  const reverser = new THREE.Group();
  reverser.position.set(-0.74, -0.58, -0.66);
  const revStub = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.14, 10), darkMetal);
  revStub.position.y = 0.07;
  reverser.add(revStub);
  root.add(reverser);

  // ── Speedometer (face + needle) ────────────────────────────────────────────
  const speedo = new THREE.Group();
  speedo.position.set(0.0, -0.46, -0.66);
  speedo.rotation.x = -0.35; // tilt the face up toward the driver
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 0.02, 32),
    new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 0.5, metalness: 0.1 }),
  );
  face.rotation.x = Math.PI / 2; // face the driver
  speedo.add(face);
  const bezel = new THREE.Mesh(
    new THREE.TorusGeometry(0.12, 0.012, 12, 32),
    new THREE.MeshStandardMaterial({ color: 0x222933, roughness: 0.6, metalness: 0.4 }),
  );
  speedo.add(bezel);
  // Needle: a thin box pivoting about the dial centre, on the face plane (XY).
  const needlePivot = new THREE.Group();
  speedo.add(needlePivot);
  const needle = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.1, 0.006),
    new THREE.MeshStandardMaterial({
      color: 0xff5533,
      emissive: 0xff3311,
      emissiveIntensity: 0.6,
      roughness: 0.4,
    }),
  );
  needle.position.set(0, 0.045, 0.012); // offset so the needle reads from centre outward
  needlePivot.add(needle);

  // ── Indicator lamps + AWS sunflower ────────────────────────────────────────
  // Lamp disc: emissive when lit; dark when off. Reuse one geometry.
  const lampGeo = new THREE.CircleGeometry(0.03, 20);
  function makeLamp(x: number, litColor: number): { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial } {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0d12,
      emissive: new THREE.Color(litColor),
      emissiveIntensity: 0,
      roughness: 0.5,
    });
    const mesh = new THREE.Mesh(lampGeo, mat);
    mesh.position.set(x, -0.4, -0.64);
    mesh.rotation.x = -0.35;
    root.add(mesh);
    return { mesh, mat };
  }
  const draLamp = makeLamp(-0.36, 0xffb020); // amber
  const dsdLamp = makeLamp(-0.28, 0xffb020); // amber
  const penaltyLamp = makeLamp(-0.2, 0xff3322); // red

  // AWS sunflower: a disc whose material flips black ↔ black/yellow. Two stacked
  // discs — a black base and a yellow "petal" ring that we show/hide.
  const sunflower = new THREE.Group();
  sunflower.position.set(0.34, -0.4, -0.64);
  sunflower.rotation.x = -0.35;
  const sunBase = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 24),
    new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.6 }),
  );
  sunflower.add(sunBase);
  // Yellow caution sectors: a ring slightly in front, toggled via visibility.
  const sunPetals = new THREE.Mesh(
    new THREE.RingGeometry(0.018, 0.034, 16, 1),
    new THREE.MeshStandardMaterial({
      color: 0xf0c020,
      emissive: 0xc09010,
      emissiveIntensity: 0.5,
      roughness: 0.5,
    }),
  );
  sunPetals.position.z = 0.001;
  sunPetals.visible = false;
  sunflower.add(sunPetals);
  root.add(sunflower);

  // ── Update (per-frame binding) ─────────────────────────────────────────────
  let wiperPhase = 0;

  // Wiper arm: a long thin blade pivoting from the bottom-left of the screen,
  // sweeping across the windscreen ahead of the eye.
  const wiper = new THREE.Group();
  wiper.position.set(-0.5, -halfH + 0.02, frameZ - 0.04);
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.025, 1.05, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.8 }),
  );
  blade.position.y = 0.5; // pivot at base
  wiper.add(blade);
  root.add(wiper);

  function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  function update(view: CabView): void {
    // Levers rotate about X (pivot at base): off→back, applied→forward.
    powerLever.rotation.x = lerp(LEVER_BACK, LEVER_FWD, clamp01(view.powerFrac));
    brakeLever.rotation.x = lerp(LEVER_BACK, LEVER_FWD, clamp01(view.brakeFrac));

    // Reverser: FWD forward, OFF centre, REV back.
    reverser.rotation.x = view.reverser === "FWD" ? 0.5 : view.reverser === "REV" ? -0.5 : 0;

    // Speedo needle: clamp to dial, map 0..full → SPEEDO_ZERO..(+sweep).
    const frac = clamp01(Math.abs(view.speedMph) / SPEEDO_FULL_MPH);
    needlePivot.rotation.z = SPEEDO_ZERO - frac * SPEEDO_SWEEP;

    // Lamps: emissive on/off.
    draLamp.mat.emissiveIntensity = view.dra ? 1.1 : 0;
    dsdLamp.mat.emissiveIntensity = view.dsd ? 1.1 : 0;
    penaltyLamp.mat.emissiveIntensity = view.penalty ? 1.3 : 0;

    // Sunflower: show yellow petals when CAUTION.
    sunPetals.visible = view.sunflower === "CAUTION";

    // Wiper: when on, advance phase off dt and sweep as a sine; when off, hold
    // the phase and ease the blade toward its park angle (clear weather).
    if (view.wiperOn) {
      wiperPhase += view.dt * WIPER_RATE;
      wiper.rotation.z = WIPER_CENTRE + Math.sin(wiperPhase) * WIPER_AMP;
    } else {
      const ease = clamp01(view.dt * 4);
      wiper.rotation.z = lerp(wiper.rotation.z, WIPER_CENTRE, ease);
    }
  }

  return { update };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
