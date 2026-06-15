// The thin, deliberately-untested impure shell. Wires keyboard → controls →
// safety → resolveInputs → step → render → HUD. Contains NO control/safety/HUD
// arithmetic — every branch that could be wrong lives in a pure, tested function
// under src/sim. `mu` is derived each frame from the pure `environmentParams(env)`
// (the default environment pins it to ADHESION.wetNight by calibration — ENV4).

import {
  buildHudView,
  createInitialControls,
  createInitialSafety,
  POWER_NOTCHES,
  reduceControls,
  resolveInputs,
  resolvedBrakeDemand,
  tickSafety,
} from "./sim/controls";
import { createInitialAws, tickAws } from "./sim/aws";
import { createInitialState, step } from "./sim/simulation";
import { EMU_GTO_4CAR } from "./sim/train";
import { WESTFORD_EASTBANK } from "./sim/route";
import {
  DEFAULT_ENVIRONMENT,
  environmentParams,
  cycleEnvironment,
  type EnvironmentParams,
} from "./sim/environment";
import { createScene, type RenderView } from "./render/scene";
import { createHud } from "./ui/hud";
import { createAudioEngine } from "./audio/engine";
import { audioParams } from "./audio/params";
import {
  intentFromActions,
  keyboardActions,
  mergeActions,
} from "./input/intent";
import { createKeyboardSource } from "./input/keyboard";
import { createGamepadSource } from "./input/gamepad";
import { createTouchControls } from "./input/touch";
import { motionParams } from "./ui/motion";
import { qualityFor } from "./render/quality";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

const route = WESTFORD_EASTBANK;
const spec = EMU_GTO_4CAR;

// Read the accessibility / device hints once (HLD §2.8): reduced-motion gates
// rain + wiper; coarse-pointer + DPR feed the performance tier.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const quality = qualityFor({
  coarsePointer,
  maxDevicePixelRatio: window.devicePixelRatio,
  reducedMotion,
});

const scene = createScene(app, route, quality);
const hud = createHud(document.body);
const audio = createAudioEngine();

// Device-agnostic input producers (HLD §2.8): keyboard owns the edge set, gamepad
// polls navigator each frame, touch overlays on coarse/narrow viewports. All three
// produce the same abstract InputActions, merged by the pure `mergeActions`.
const kb = createKeyboardSource();
const pad = createGamepadSource();
const touch = createTouchControls(app);

let state = createInitialState(0);
let controls = createInitialControls();
let safety = createInitialSafety();
let aws = createInitialAws();
let env = DEFAULT_ENVIRONMENT;

window.addEventListener("resize", () => scene.resize());

// Autoplay policy: the AudioContext may only resume after a user gesture. Start
// it on the first keydown/pointerdown, then drop the listeners.
function startAudioOnce(): void {
  audio.start();
  window.removeEventListener("keydown", startAudioOnce);
  window.removeEventListener("pointerdown", startAudioOnce);
}
window.addEventListener("keydown", startAudioOnce);
window.addEventListener("pointerdown", startAudioOnce);

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05); // the ONLY wall-clock
  last = now;

  // Merge every device into one abstract action set, then map to the intent.
  const actions = mergeActions(keyboardActions(kb.edges()), pad.actions(), touch.actions());
  const intent = intentFromActions(actions);

  // Demo affordance: cycleEnvironment steps the preset ring (NOT a ControlIntent
  // — it drives no train control, so it's handled here via the pure cycle fn).
  if (actions.cycleEnvironment) env = cycleEnvironment(env);

  // Accessibility: reduced motion cuts rain and parks the wiper. Build a fresh
  // EnvironmentParams (never mutate the pure result) with the gates applied.
  const motion = motionParams(reducedMotion);
  const base = environmentParams(env);
  const ep: EnvironmentParams = {
    ...base,
    rainIntensity: base.rainIntensity * motion.rainScale,
    wiperOn: base.wiperOn && motion.wiperEnabled,
  };

  controls = reduceControls(controls, intent, state, safety); // safety = prior frame's
  const inputs = resolveInputs(controls, safety, ep.mu);
  const prevChainage = state.chainage; // pre-step
  state = step(spec, route, state, inputs, dt); // advance FIRST (crossing detection needs prev→now)
  const dir = controls.lastDir; // same authority resolveInputs uses
  const awsOut = tickAws(aws, state, route, intent, prevChainage, dir, dt); // post-step chainage
  aws = awsOut.next;
  safety = tickSafety(safety, intent, state, dt, { reasons: awsOut.reasons });

  const view: RenderView = {
    chainage: state.chainage,
    speed: state.speed,
    dt,
    controls,
    safety,
    aws,
    served: aws.served,
    env: ep,
  };
  scene.render(view);
  hud.update(buildHudView(state, controls, safety, route, aws.served, awsOut.hud));

  // Audio: whine under power, rolling with speed, hiss with the resolved brake
  // demand (lever ∨ penalty full-service) — same authority the physics uses.
  const brakeDemand = resolvedBrakeDemand(controls, safety);
  audio.update(audioParams(state.speed, controls.powerNotch / POWER_NOTCHES, brakeDemand));

  kb.clear();
}
requestAnimationFrame(frame);
