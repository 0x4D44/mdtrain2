// The thin, deliberately-untested impure shell (§2.10). Wires keyboard →
// controls → safety → resolveInputs → step → render → HUD. Contains NO
// control/safety/HUD arithmetic — every branch that could be wrong lives in a
// pure, tested function under src/sim. `mu` stays hardwired ADHESION.wetNight.

import {
  buildHudView,
  createInitialControls,
  createInitialSafety,
  reduceControls,
  resolveInputs,
  tickSafety,
  type ControlIntent,
} from "./sim/controls";
import { createInitialAws, tickAws } from "./sim/aws";
import { createInitialState, step } from "./sim/simulation";
import { EMU_GTO_4CAR, ADHESION } from "./sim/train";
import { WESTFORD_EASTBANK } from "./sim/route";
import { createScene } from "./render/scene";
import { createHud } from "./ui/hud";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

const route = WESTFORD_EASTBANK;
const spec = EMU_GTO_4CAR;
const scene = createScene(app, route);
const hud = createHud(document.body);

let state = createInitialState(0);
let controls = createInitialControls();
let safety = createInitialSafety();
let aws = createInitialAws();

// Per-frame edge set of just-pressed key codes (keydown ignores auto-repeat so a
// hold never re-fires a detent; keyup/blur are housekeeping).
const edges = new Set<string>();
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  edges.add(e.code);
});
window.addEventListener("keyup", (e) => edges.delete(e.code));
window.addEventListener("blur", () => edges.clear());
window.addEventListener("resize", () => scene.resize());

// Inline ~20-line decision-free keymap: edge set → ControlIntent (§2.3).
function intentFromKeys(edgeSet: ReadonlySet<string>): ControlIntent {
  const has = (code: string): boolean => edgeSet.has(code);
  return {
    powerUp: has("KeyW"),
    powerDown: has("KeyS"),
    brakeUp: has("KeyD"),
    brakeDown: has("KeyA"),
    emergency: has("Backquote"),
    reverserFwd: has("KeyF"),
    reverserOff: has("KeyN"),
    reverserRev: has("KeyR"),
    toggleDra: has("KeyL"),
    acknowledge: has("KeyQ"),
    vigilancePing: edgeSet.size > 0,
  };
}

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05); // the ONLY wall-clock
  last = now;

  const intent = intentFromKeys(edges);
  controls = reduceControls(controls, intent, state, safety); // safety = prior frame's
  const inputs = resolveInputs(controls, safety, ADHESION.wetNight);
  const prevChainage = state.chainage; // pre-step
  state = step(spec, route, state, inputs, dt); // advance FIRST (crossing detection needs prev→now)
  const dir = controls.lastDir; // same authority resolveInputs uses
  const awsOut = tickAws(aws, state, route, intent, prevChainage, dir, dt); // post-step chainage
  aws = awsOut.next;
  safety = tickSafety(safety, intent, state, dt, { reasons: awsOut.reasons });
  scene.render(state.chainage);
  hud.update(buildHudView(state, controls, safety, route, aws.served, awsOut.hud));

  edges.clear();
}
requestAnimationFrame(frame);
