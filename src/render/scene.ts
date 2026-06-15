// src/render/scene.ts — the IMPURE integrator (HLD §2.6 (a)-(h)). It wires the
// PURE curvilinear core (centerline/terrain/camera) + the R1/R2/R4 render layers
// into one rendered world: ACES tone-mapping, a gradient sky dome + tiny equirect
// IBL, the terrain/track/viaduct/tunnel/sea geometry (terrain-mesh), lineside
// furniture placed via placeOnCentreline, an eye-tracking shadow sun, async bloom,
// and eye-anchored rain. NO spatial math lives here — every position comes from
// the pure layer; this file only applies Three facing offsets (+π, D21), eases the
// cab attitude, and re-parameterises materials/lights per frame (no per-frame GPU
// allocation — geometry/materials/render-targets are built once; the pure core
// returns a few small value objects each frame, but nothing GPU-side is allocated).

import * as THREE from "three";
// Type-only references to the lazy bloom modules: `import type` keeps them OUT of
// the main chunk (a value import would fold them in — D22/finding #10). The actual
// modules are reached ONLY via the dynamic import() in startBloom().
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { ControlState, SafetyState } from "../sim/controls";
import { BRAKE_EMERGENCY, POWER_NOTCHES, penaltyActive } from "../sim/controls";
import type { AwsState } from "../sim/aws";
import type { Route, Station } from "../sim/route";
import { aspectAt, gradeAt } from "../sim/route";
import type { EnvironmentParams } from "../sim/environment";
import { centerlineAt, placeOnCentreline, headingAt } from "../sim/centerline";
import { formationHeight, anchorY, viaductSpanAt, boreCorridorAt } from "../sim/terrain";
import { eyePose, cabAttitudeTarget, EYE_HEIGHT, EYE_D } from "../sim/camera";
import { createCab, type CabView } from "./cab";
import { buildScenery } from "./scenery";
import { buildWorld, type WorldHandle } from "./terrain-mesh";
import { makeEnvEquirect, disposeEnvEquirect } from "./textures";
import type { QualitySettings } from "./quality";

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
   *  current environment. */
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

// Standard gauge (m) — only for lineside-furniture lateral clearances.
const GAUGE = 1.435;

// Cab seating: driver on the LEFT (EYE_D = −0.5); furniture slid right so the
// centre pillar is to the driver's right.
const CAB_SHIFT = 0.5;

// Cab-attitude ease rate (per-second approach toward the target pitch/roll).
const ATTITUDE_EASE = 4.0;

// Eye-tracking shadow sun: distance along sunDir from the eye + ortho half-extent.
const SUN_DISTANCE = 140; // m back along sunDir to place the light
const SHADOW_HALF = 100; // ±100 m ortho frustum (HLD §2.6f)
const SHADOW_MAP = 2048; // desktop shadow map size

// Defaults preserving today's behaviour when no quality opts are supplied.
const DEFAULT_RAIN_COUNT = 2400;
const DEFAULT_PIXEL_RATIO_CAP = 2;

/**
 * Quality knobs from the pure `qualityFor` tier (HLD §2.7). It is the full
 * QualitySettings (main.ts passes the tier straight through); the extra fields
 * (shadows/bloom/ribbon/attitude) drive the world build + render path. All
 * optional so callers may still pass a minimal `{ rainCount, pixelRatioCap }`.
 */
export interface SceneOptions {
  rainCount?: number; // rain particles to allocate (default 2400; 0 builds empty)
  pixelRatioCap?: number; // clamp on devicePixelRatio (default 2)
  shadowsEnabled?: boolean; // eye-tracking directional shadow
  bloomEnabled?: boolean; // lazy bloom composer
  ribbonHalfWidth?: number; // terrain ribbon half-width (m)
  terrainSegLen?: number; // terrain ribbon segment length (m)
  terrainSubdiv?: number; // terrain ribbon cross subdivisions
  attitudeScale?: number; // cab pitch/roll response scale (0 disables)
}

/** Approach `cur` toward `target` by an eased fraction of dt (frame-rate-stable). */
function approach(cur: number, target: number, rate: number, dt: number): number {
  const t = 1 - Math.exp(-rate * Math.max(0, dt));
  return cur + (target - cur) * t;
}

/**
 * Build the Grand-World scene + cab (HLD §2.6). The cab is created internally and
 * parented to a train-fixed mount, so `main.ts` stays thin. Geometry/materials/
 * render-targets are created once; the per-frame loops allocate nothing — only the
 * tiny env map is dispose+rebuilt when the sky/ground colour changes.
 */
export function createScene(parent: HTMLElement, route: Route, opts?: SceneOptions): SceneHandle {
  const rainCount = opts?.rainCount ?? DEFAULT_RAIN_COUNT;
  const pixelRatioCap = opts?.pixelRatioCap ?? DEFAULT_PIXEL_RATIO_CAP;
  const shadowsEnabled = opts?.shadowsEnabled ?? false;
  const bloomEnabled = opts?.bloomEnabled ?? false;
  const attitudeScale = opts?.attitudeScale ?? 0;
  // The terrain ribbon needs the full tier; default to a coarse, safe build when
  // the caller supplies only the legacy rain/pixel opts.
  const tier: QualitySettings = {
    pixelRatioCap,
    rainCount,
    shadowsEnabled,
    bloomEnabled,
    ribbonHalfWidth: opts?.ribbonHalfWidth ?? 110,
    terrainSegLen: opts?.terrainSegLen ?? 20,
    terrainSubdiv: opts?.terrainSubdiv ?? 10,
    attitudeScale,
  };

  // ── Renderer: ACES tone-mapping + sRGB output + optional PCFSoft shadows ────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  if (shadowsEnabled) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  parent.appendChild(renderer.domElement);
  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080f);
  scene.fog = new THREE.Fog(0x05080f, 25, 260);

  const camera = new THREE.PerspectiveCamera(70, parent.clientWidth / parent.clientHeight, 0.05, 4000);
  camera.rotation.order = "YXZ"; // yaw then pitch, for clean look-around

  // ── Look-around: drag with the LEFT mouse button to turn the driver's head ──
  const LOOK_SENS = 0.0042; // rad per pixel dragged
  let lookYaw = 0;
  let lookPitch = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // LMB only
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    lookYaw -= (e.clientX - lastX) * LOOK_SENS; // drag right → look right
    lookPitch -= (e.clientY - lastY) * LOOK_SENS; // drag down → look down
    lastX = e.clientX;
    lastY = e.clientY;
    lookYaw = Math.max(-2.4, Math.min(2.4, lookYaw)); // ~±137° (over the shoulder)
    lookPitch = Math.max(-0.7, Math.min(0.7, lookPitch));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ── Sky dome: a large back-side sphere with a vertical gradient (fog:false so
  //    it always reads above the horizon band). Colours are written per frame. ──
  const skyUniforms = {
    topColor: { value: new THREE.Color(0x05080f) },
    bottomColor: { value: new THREE.Color(0x0a1228) },
    offset: { value: 33 },
    exponent: { value: 0.6 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPosition = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 24, 12), skyMat);
  scene.add(sky);

  // ── IBL env map (tiny equirect, rebuilt+disposed on sky/ground colour change) ─
  let envTex: THREE.Texture = makeEnvEquirect(0x05080f, 0x0e140f);
  scene.environment = envTex;
  let envSkyHex = 0x05080f;
  let envGroundHex = 0x0e140f;

  // ── Lighting: hemi + moon fill (driven by env each frame) ──────────────────
  const hemi = new THREE.HemisphereLight(0x1a2636, 0x03040a, 0.35);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x8aa0c8, 0.4);
  moon.position.set(-40, 80, -20);
  scene.add(moon);

  // ── Eye-tracking shadow sun (gated by shadowsEnabled). Its position + target
  //    move with the eye each frame; its ortho frustum is ±SHADOW_HALF. ─────────
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  const sunTarget = new THREE.Object3D();
  scene.add(sun);
  scene.add(sunTarget);
  sun.target = sunTarget;
  if (shadowsEnabled) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_HALF;
    cam.right = SHADOW_HALF;
    cam.top = SHADOW_HALF;
    cam.bottom = -SHADOW_HALF;
    cam.near = 1;
    cam.far = SUN_DISTANCE + SHADOW_HALF * 2;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }

  // ── World geometry (R2): ground + track + viaduct + tunnel + sea ────────────
  const world: WorldHandle = buildWorld(scene, route, tier, anisotropy);

  // ── Lineside furniture (this file) + props (R4) ─────────────────────────────
  for (const station of route.stations) buildStation(scene, route, station);
  const heads = buildSignals(scene, route);
  buildLineside(scene, route);
  buildScenery(scene, route, GAUGE); // trees, overbridges, platform people

  // ── Contact wire: swept along the spine at pantograph height (R2 builds the
  //    track ribbon but not the wire — sweep it here). One InstancedMesh. ──────
  buildContactWire(scene, route);

  // ── Rain (one THREE.Points, scrolled + wrapped, no per-frame allocation) ───
  const rainPos = new Float32Array(rainCount * 3);
  for (let i = 0; i < rainCount; i++) {
    rainPos[i * 3 + 0] = (Math.random() * 2 - 1) * RAIN_HALF_X;
    rainPos[i * 3 + 1] = Math.random() * 2 * RAIN_HALF_Y; // 0..2H, wrapped about eye.y
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
    fog: false,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled = false;
  scene.add(rain);

  // ── Cab: mounted on a train-fixed node (NOT the camera) so look-around turns
  //    the head inside a fixed cab. Driver sits on the LEFT (EYE_D = −0.5). ────
  const cabMount = new THREE.Group();
  scene.add(cabMount);
  const cab = createCab(cabMount, CAB_SHIFT);

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

  // ── Async bloom composer (D22): created lazily; until ready we render direct
  //    to canvas (ACES on the renderer). Never started when bloom is disabled. ──
  let composer: EffectComposer | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let bloomLoading = false;
  let bloomFailed = false; // permanent latch: never retry a failed lazy import
  function startBloom(): void {
    if (bloomLoading || composer || bloomFailed) return;
    bloomLoading = true;
    Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ])
      .then(([ec, rp, ub, op]) => {
        const size = new THREE.Vector2(parent.clientWidth, parent.clientHeight);
        const comp = new ec.EffectComposer(renderer);
        comp.addPass(new rp.RenderPass(scene, camera));
        const bloom = new ub.UnrealBloomPass(size, 0.6, 0.6, 0.85);
        comp.addPass(bloom);
        comp.addPass(new op.OutputPass()); // applies ACES + sRGB once
        comp.setSize(parent.clientWidth, parent.clientHeight);
        composer = comp;
        bloomPass = bloom;
      })
      .catch(() => {
        // Bloom is purely cosmetic; on any failure latch OFF permanently and keep
        // the direct-to-canvas ACES path — never retry (no per-frame import storm).
        bloomFailed = true;
        bloomLoading = false;
      });
  }

  // Reusable per-frame scratch (NO per-frame allocation).
  const sunDirVec = new THREE.Vector3();

  // Eased cab attitude (live pitch/roll easing toward the target each frame).
  let easedPitch = 0;
  let easedRoll = 0;

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

  function updateRain(view: RenderView, eyeX: number, eyeY: number, eyeZ: number): void {
    const dt = view.dt;
    const fall = RAIN_FALL * dt;
    const slant = fall * RAIN_SLANT + Math.abs(view.speed) * dt * 0.25;
    const pos = rainGeo.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < rainCount; i++) {
      const yi = i * 3 + 1;
      const zi = i * 3 + 2;
      let y = arr[yi]! - fall; // fall relative to the eye
      let z = arr[zi]! - slant; // slant backward as the train pushes forward
      if (y < 0) y += 2 * RAIN_HALF_Y;
      if (z < -RAIN_HALF_Z) z += 2 * RAIN_HALF_Z;
      arr[yi] = y;
      arr[zi] = z;
    }
    pos.needsUpdate = true;
    // Anchor the cloud to the eye (HLD §2.6c — not the hard x=0 of old code).
    rain.position.set(eyeX, eyeY - RAIN_HALF_Y, eyeZ);
  }

  function render(view: RenderView): void {
    const env = view.env;
    const s = view.chainage;

    // ── Camera + cab pose from the PURE eye pose (HLD §2.6a) ───────────────────
    const eye = eyePose(route, s, EYE_D, EYE_HEIGHT);
    // Ease the live attitude toward the pure target (cant from the centreline,
    // grade from the route). attitudeScale=0 ⇒ target {0,0} ⇒ stays flat.
    const cant = centerlineAt(route, s).cant;
    const grade = gradeAt(route, s);
    const target = cabAttitudeTarget(cant, grade, attitudeScale);
    easedPitch = approach(easedPitch, target.pitch, ATTITUDE_EASE, view.dt);
    easedRoll = approach(easedRoll, target.roll, ATTITUDE_EASE, view.dt);

    camera.position.set(eye.x, eye.y, eye.z);
    // +π faces +Z down the line (D21); look offsets add on top.
    camera.rotation.set(easedPitch + lookPitch, eye.heading + Math.PI + lookYaw, easedRoll);
    cabMount.position.set(eye.x, eye.y, eye.z);
    cabMount.rotation.set(easedPitch, eye.heading + Math.PI, easedRoll); // no look offset

    // ── Apply the environment (exposure/sky/fog, lights, rain, rail sheen) ─────
    renderer.toneMappingExposure = env.exposure;
    (scene.background as THREE.Color).setHex(env.skyColor);
    skyUniforms.topColor.value.setHex(env.skyColor).multiplyScalar(0.35); // darkened zenith
    skyUniforms.bottomColor.value.setHex(env.skyColor);
    const fog = scene.fog as THREE.Fog;
    fog.color.setHex(env.skyColor);
    fog.near = env.fogNear;
    fog.far = env.fogFar;
    hemi.color.setHex(env.hemiSky);
    hemi.groundColor.setHex(env.hemiGround);
    hemi.intensity = env.ambientIntensity;
    moon.color.setHex(env.sunColor);
    moon.intensity = env.moonIntensity;
    rainMat.opacity = env.rainIntensity;
    world.railMaterial.roughness = world.railRoughnessFor(env.railWetness);

    // ── Eye-tracking shadow sun: move with the eye along env.sunDir ────────────
    if (shadowsEnabled) {
      sunDirVec.set(env.sunDir.x, env.sunDir.y, env.sunDir.z);
      sunTarget.position.set(eye.x, eye.y, eye.z);
      sun.position.copy(sunTarget.position).addScaledVector(sunDirVec, SUN_DISTANCE);
      sun.color.setHex(env.sunColorPbr);
      sun.intensity = env.moonIntensity; // sun/moon share the directional budget
    }

    // ── Env map rebuild on sky/ground colour change (only permitted rebuild) ──
    if (env.skyColor !== envSkyHex || env.groundColor !== envGroundHex) {
      disposeEnvEquirect(envTex);
      envTex = makeEnvEquirect(env.skyColor, env.groundColor);
      scene.environment = envTex;
      envSkyHex = env.skyColor;
      envGroundHex = env.groundColor;
    }

    updateSignals(view);
    if (env.rainIntensity > 0) updateRain(view, eye.x, eye.y, eye.z);

    // ── Project the cab view from sim state ────────────────────────────────────
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

    // ── Bloom (D22): start the lazy load the first frame bloom is wanted; until
    //    the composer is ready (and whenever bloom is off) render direct. ───────
    if (bloomEnabled) {
      if (!composer) startBloom();
      if (composer && bloomPass) {
        bloomPass.strength = env.bloomStrength;
        composer.render();
        return;
      }
    }
    renderer.render(scene, camera);
  }

  function resize(): void {
    const w = parent.clientWidth, h = parent.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
  }

  return { render, resize };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lineside furniture — every object placed via placeOnCentreline (HLD §2.6b).
// Front-+Z meshes use the bare math heading; rear-facing signal lamps / name
// boards use heading+π so they face the approaching (−Z-local) train.
// ─────────────────────────────────────────────────────────────────────────────

interface SignalHead {
  red: THREE.MeshStandardMaterial;
  amberTop: THREE.MeshStandardMaterial;
  amberBot: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  glow: THREE.Sprite;
}

/** One 3-D signal head per route.signals[i], placed beside the line and turned to
 *  face the approaching train (lamps on the heading+π side). Built once; the
 *  per-frame loop only writes emissive intensities. */
function buildSignals(scene: THREE.Scene, route: Route): SignalHead[] {
  const heads: SignalHead[] = [];
  const sideD = GAUGE / 2 + 2.2; // signal stands to the right (+d) of the track
  const lampGeo = new THREE.CircleGeometry(0.16, 16);
  const glowTex = makeGlowTexture();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.8, metalness: 0.3 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.9 });

  for (const sig of route.signals) {
    const head = new THREE.Group();
    const place = placeOnCentreline(route, sig.chainage, sideD);
    const formY = formationHeight(route, sig.chainage);
    head.position.set(place.x, formY, place.z);
    // Face the approaching train: lamps point toward −Z-local, so rotate the
    // whole head by heading+π (D21 rear-facing convention).
    head.rotation.y = place.heading + Math.PI;

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 10), postMat);
    post.position.y = 2.1;
    head.add(post);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 0.1), boardMat);
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
      // After the head's heading+π yaw, +Z-local points back at the train; the
      // discs face +Z so the lit lamp is visible to the driver.
      disc.position.set(0, y, 0.06);
      head.add(disc);
      return mat;
    };
    const red = mkLamp(4.55, ASPECT_COLOUR.RED);
    const amberTop = mkLamp(4.2, ASPECT_COLOUR.YELLOW);
    const amberBot = mkLamp(3.85, ASPECT_COLOUR.YELLOW);
    const green = mkLamp(3.5, ASPECT_COLOUR.GREEN);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    glow.scale.set(2.4, 2.4, 1);
    glow.position.set(0, 4.0, 0.1);
    head.add(glow);

    scene.add(head);
    heads.push({ red, amberTop, amberBot, green, glow });
  }
  return heads;
}

/**
 * OLE/catenary masts (~45 m, alternating sides), lineside fencing (both sides),
 * and mileposts (~500 m), each placed via placeOnCentreline at formationHeight so
 * they follow the bent, undulating line. Each class is ONE InstancedMesh built
 * once. Props inside the viaduct valley or tunnel bore corridor are skipped.
 */
function buildLineside(scene: THREE.Scene, route: Route): void {
  const len = route.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, "YXZ");
  const sc = new THREE.Vector3(1, 1, 1);
  const v = new THREE.Vector3();
  const PARK = -1000; // unused instances parked below the world

  // ── OLE masts: post + cantilever arm, alternating sides, every ~45 m ─────────
  const mastSpacing = 45;
  const mastN = Math.max(1, Math.floor(len / mastSpacing));
  const mastD = GAUGE / 2 + 2.6;
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x10141a, roughness: 0.7, metalness: 0.5 });
  const masts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 6.5, 0.18), mastMat, mastN);
  const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.12, 0.12), mastMat, mastN);
  for (let i = 0; i < mastN; i++) {
    const s = (i + 1) * mastSpacing;
    const side = i % 2 === 0 ? 1 : -1;
    // Skip OLE in the viaduct gap and through the tunnel bore (as fences/mileposts do).
    const skip = viaductSpanAt(route, s) || boreCorridorAt(route, s, side * mastD);
    const heading = headingAt(route, s);
    e.set(0, heading, 0);
    q.setFromEuler(e);
    const formY = formationHeight(route, s);
    if (skip) {
      m.compose(v.set(0, PARK, 0), q, sc);
      masts.setMatrixAt(i, m);
      arms.setMatrixAt(i, m);
      continue;
    }
    const cPost = placeOnCentreline(route, s, side * mastD);
    m.compose(v.set(cPost.x, formY + 3.25, cPost.z), q, sc);
    masts.setMatrixAt(i, m);
    // Cantilever arm reaching in over the track at pantograph height.
    const cArm = placeOnCentreline(route, s, side * (mastD - 1.2));
    m.compose(v.set(cArm.x, formY + 6.0, cArm.z), q, sc);
    arms.setMatrixAt(i, m);
  }
  masts.instanceMatrix.needsUpdate = true;
  arms.instanceMatrix.needsUpdate = true;
  scene.add(masts, arms);

  // ── Lineside fencing: instanced posts both sides every ~6 m ─────────────────
  const fenceSpacing = 6;
  const fenceN = Math.max(1, Math.floor(len / fenceSpacing));
  const fenceD = GAUGE / 2 + 4.5;
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x0e1116, roughness: 0.9 });
  const fence = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), fenceMat, fenceN * 2);
  let fi = 0;
  for (let i = 0; i < fenceN; i++) {
    const s = (i + 1) * fenceSpacing;
    const heading = headingAt(route, s);
    e.set(0, heading, 0);
    q.setFromEuler(e);
    for (const side of [-1, 1] as const) {
      const d = side * fenceD;
      if (viaductSpanAt(route, s) || boreCorridorAt(route, s, d)) {
        m.compose(v.set(0, PARK, 0), q, sc);
        fence.setMatrixAt(fi++, m);
        continue;
      }
      const c = placeOnCentreline(route, s, d);
      m.compose(v.set(c.x, anchorY(route, s, d, 0.5), c.z), q, sc);
      fence.setMatrixAt(fi++, m);
    }
  }
  fence.instanceMatrix.needsUpdate = true;
  scene.add(fence);

  // ── Mileposts every ~500 m: tiny posts beside the line ──────────────────────
  const postSpacing = 500;
  const postN = Math.max(1, Math.floor(len / postSpacing));
  const milepostD = GAUGE / 2 + 2.0;
  const milepostMat = new THREE.MeshStandardMaterial({ color: 0xb0b4ba, roughness: 0.8 });
  const mileposts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.6, 0.1), milepostMat, postN);
  for (let i = 0; i < postN; i++) {
    const s = (i + 1) * postSpacing;
    const heading = headingAt(route, s);
    e.set(0, heading, 0);
    q.setFromEuler(e);
    if (viaductSpanAt(route, s) || boreCorridorAt(route, s, milepostD)) {
      m.compose(v.set(0, PARK, 0), q, sc);
      mileposts.setMatrixAt(i, m);
      continue;
    }
    const c = placeOnCentreline(route, s, milepostD);
    m.compose(v.set(c.x, anchorY(route, s, milepostD, 0.3), c.z), q, sc);
    mileposts.setMatrixAt(i, m);
  }
  mileposts.instanceMatrix.needsUpdate = true;
  scene.add(mileposts);
}

/** The contact wire: a thin box swept along the spine at pantograph height, one
 *  InstancedMesh segment per ~20 m, following the curve at formationHeight. */
function buildContactWire(scene: THREE.Scene, route: Route): void {
  const len = route.length;
  const SEG = 20;
  const segN = Math.max(1, Math.ceil(len / SEG));
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.5, metalness: 0.6 });
  const wire = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.03, SEG + 0.1), wireMat, segN);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, "YXZ");
  const sc = new THREE.Vector3(1, 1, 1);
  const v = new THREE.Vector3();
  for (let i = 0; i < segN; i++) {
    const sMid = Math.min(len, (i + 0.5) * SEG);
    const heading = headingAt(route, sMid);
    const c = placeOnCentreline(route, sMid, 0);
    const formY = formationHeight(route, sMid);
    e.set(0, heading, 0);
    q.setFromEuler(e);
    m.compose(v.set(c.x, formY + 5.9, c.z), q, sc);
    wire.setMatrixAt(i, m);
  }
  wire.instanceMatrix.needsUpdate = true;
  scene.add(wire);
}

/**
 * One station beside the line (HLD §2.6b), placed via placeOnCentreline so it
 * follows the (possibly curved) platform and sits on the real terrain. A platform
 * slab, back wall, canopy on posts, an emissive name board (facing the train) and
 * ≤ 2 platform lamps. Built once. The platform sits on the +d side at
 * formationHeight (slab top platTop above the rail), matching R4 platform people.
 */
function buildStation(scene: THREE.Scene, route: Route, station: Station): void {
  const z0 = station.chainage;
  const len = 2 * station.platformHalf;
  const platW = 3.0; // platform width, m
  const platH = 0.9; // platform height above the formation, m
  const innerD = GAUGE / 2 + 0.7; // platform edge just clear of the running rail
  const centreD = innerD + platW / 2; // platform centre on the +d side
  const formY = formationHeight(route, z0);

  const group = new THREE.Group();
  const place = placeOnCentreline(route, z0, 0);
  group.position.set(place.x, formY, place.z);
  group.rotation.y = place.heading; // front-+Z structure: bare math heading (D21)

  const concrete = new THREE.MeshStandardMaterial({ color: 0x52585f, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c333c, roughness: 0.85 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x2a313b, roughness: 0.6, metalness: 0.4 });

  // Platform slab (local +X = +d side; long axis along local Z = the track).
  const slab = new THREE.Mesh(new THREE.BoxGeometry(platW, platH, len), concrete);
  slab.position.set(centreD, platH / 2, 0);
  slab.receiveShadow = true;
  group.add(slab);

  // Back wall (behind the platform, away from the track).
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, len), wallMat);
  wall.position.set(centreD + platW / 2 - 0.1, platH + 1.3, 0);
  group.add(wall);

  // Canopy: a flat roof on three posts.
  const canopyY = platH + 3.0;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(platW, 0.12, len * 0.8), steelMat);
  canopy.position.set(centreD, canopyY, 0);
  group.add(canopy);
  const postGeo = new THREE.BoxGeometry(0.12, canopyY - platH, 0.12);
  for (const pz of [-len * 0.35, 0, len * 0.35]) {
    const post = new THREE.Mesh(postGeo, steelMat);
    post.position.set(centreD - platW / 2 + 0.3, platH + (canopyY - platH) / 2, pz);
    group.add(post);
  }

  // Emissive name board, facing the track (−d, local −X) so an arriving train
  // reads it; bright enough to glow as a landmark in the dark.
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.5, 3.2),
    new THREE.MeshStandardMaterial({
      color: 0x0a1020,
      emissive: new THREE.Color(0x3168c0),
      emissiveIntensity: 2.0,
      roughness: 0.5,
    }),
  );
  board.position.set(innerD + 0.05, platH + 1.7, 0);
  group.add(board);

  // ≤ 2 platform lamps: a bright emissive disc + one PointLight each.
  const lampGeo = new THREE.CircleGeometry(0.12, 16);
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x101418,
    emissive: new THREE.Color(0xffe2b0),
    emissiveIntensity: 2.6,
    roughness: 0.5,
  });
  for (const lz of [-len * 0.3, len * 0.3]) {
    const disc = new THREE.Mesh(lampGeo, lampMat);
    disc.position.set(centreD, platH + 3.4, lz);
    disc.rotation.x = Math.PI / 2; // face down
    group.add(disc);
    const light = new THREE.PointLight(0xffe2b0, 3.0, 24);
    light.position.set(centreD, platH + 3.3, lz);
    group.add(light);
  }

  scene.add(group);
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
