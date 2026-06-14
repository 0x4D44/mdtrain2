import { EMU_GTO_4CAR, ADHESION } from "./sim/train";
import { WESTFORD_EASTBANK } from "./sim/route";
import { createInitialState, step, currentSpeedLimit, type SimInputs } from "./sim/simulation";
import { createScene } from "./render/scene";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

const route = WESTFORD_EASTBANK;
const spec = EMU_GTO_4CAR;
const scene = createScene(app, route);
let state = createInitialState(0);

// Phase-0 controls: hold W/S to ramp power, A/D to ramp brake, X to reverse.
const held = new Set<string>();
let dir: 1 | -1 = 1;
const controls = { notch: 0, brake: 1 };
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyX" && Math.abs(state.speed) < 0.5) dir = dir === 1 ? -1 : 1;
  else held.add(e.code);
});
window.addEventListener("keyup", (e) => held.delete(e.code));
window.addEventListener("blur", () => held.clear());
window.addEventListener("resize", () => scene.resize());

const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;left:14px;top:12px;font:14px/1.5 ui-monospace,monospace;color:#cfe0f5;text-shadow:0 1px 2px #000;pointer-events:none";
document.body.appendChild(hud);

const MPH = 2.236936;
let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const rate = 0.6 * dt;
  if (held.has("KeyW")) controls.notch = Math.min(1, controls.notch + rate);
  if (held.has("KeyS")) controls.notch = Math.max(0, controls.notch - rate);
  if (held.has("KeyA")) controls.brake = Math.max(0, controls.brake - rate);
  if (held.has("KeyD")) controls.brake = Math.min(1, controls.brake + rate);

  const inputs: SimInputs = { notch: controls.notch, brake: controls.brake, dir, mu: ADHESION.wetNight };
  state = step(spec, route, state, inputs, dt);
  scene.render(state.chainage);

  const limit = currentSpeedLimit(route, state);
  hud.textContent =
    `${(Math.abs(state.speed) * MPH).toFixed(0)} mph  (limit ${(limit * MPH).toFixed(0)})  ` +
    `${dir === 1 ? "FWD" : "REV"}  pwr ${(controls.notch * 100) | 0}%  brk ${(controls.brake * 100) | 0}%  ` +
    `ch ${state.chainage.toFixed(0)}m\nW/S power · A/D brake · X reverse`;
}
requestAnimationFrame(frame);
