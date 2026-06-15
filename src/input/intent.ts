// Device-agnostic input model (PURE — no DOM/Three/Gamepad/wall-clock/Math.random).
// Every input device (keyboard, gamepad, touch) produces the SAME abstract
// `InputActions` record; `mergeActions` ORs them and `intentFromActions` maps the
// result onto the existing `ControlIntent`. This is the load-bearing seam: keyboard
// parity is provable (REG-INPUT), and a new device is just another producer.

import type { ControlIntent } from "../sim/controls";

/**
 * The abstract, device-independent set of driver actions for one frame. The ten
 * control actions mirror `ControlIntent`'s ten control edges; `cycleEnvironment`
 * is a demo affordance consumed separately by the shell (it drives no train
 * control); `anyActivity` records "any input happened this frame" and feeds
 * `vigilancePing`.
 */
export interface InputActions {
  powerUp: boolean;
  powerDown: boolean;
  brakeUp: boolean;
  brakeDown: boolean;
  emergency: boolean;
  reverserFwd: boolean;
  reverserOff: boolean;
  reverserRev: boolean;
  toggleDra: boolean;
  acknowledge: boolean;
  cycleEnvironment: boolean; // demo env cycle (was main's KeyE) — NOT a ControlIntent
  anyActivity: boolean; // drives vigilancePing
}

/** The all-false action record (no input). */
export const NO_ACTIONS: InputActions = {
  powerUp: false,
  powerDown: false,
  brakeUp: false,
  brakeDown: false,
  emergency: false,
  reverserFwd: false,
  reverserOff: false,
  reverserRev: false,
  toggleDra: false,
  acknowledge: false,
  cycleEnvironment: false,
  anyActivity: false,
};

/**
 * OR-combine any number of producers so keyboard + gamepad + touch can all be live
 * at once. Every boolean field is the OR across sources (including `anyActivity`).
 * `mergeActions()` with no args returns `NO_ACTIONS` (the OR identity).
 */
export function mergeActions(...sources: InputActions[]): InputActions {
  const out: InputActions = { ...NO_ACTIONS };
  for (const s of sources) {
    out.powerUp = out.powerUp || s.powerUp;
    out.powerDown = out.powerDown || s.powerDown;
    out.brakeUp = out.brakeUp || s.brakeUp;
    out.brakeDown = out.brakeDown || s.brakeDown;
    out.emergency = out.emergency || s.emergency;
    out.reverserFwd = out.reverserFwd || s.reverserFwd;
    out.reverserOff = out.reverserOff || s.reverserOff;
    out.reverserRev = out.reverserRev || s.reverserRev;
    out.toggleDra = out.toggleDra || s.toggleDra;
    out.acknowledge = out.acknowledge || s.acknowledge;
    out.cycleEnvironment = out.cycleEnvironment || s.cycleEnvironment;
    out.anyActivity = out.anyActivity || s.anyActivity;
  }
  return out;
}

/**
 * Map the abstract actions onto the existing `ControlIntent` (the ten control
 * edges + `vigilancePing`). `cycleEnvironment` is deliberately NOT part of
 * `ControlIntent` — the shell consumes it directly.
 */
export function intentFromActions(a: InputActions): ControlIntent {
  return {
    powerUp: a.powerUp,
    powerDown: a.powerDown,
    brakeUp: a.brakeUp,
    brakeDown: a.brakeDown,
    emergency: a.emergency,
    reverserFwd: a.reverserFwd,
    reverserOff: a.reverserOff,
    reverserRev: a.reverserRev,
    toggleDra: a.toggleDra,
    acknowledge: a.acknowledge,
    vigilancePing: a.anyActivity,
  };
}

/**
 * Keyboard producer: reproduces today's inline `intentFromKeys` map EXACTLY.
 *   W KeyW → powerUp     S KeyS → powerDown
 *   D KeyD → brakeUp     A KeyA → brakeDown
 *   Backquote → emergency
 *   F → reverserFwd      N → reverserOff      R → reverserRev
 *   L → toggleDra        Q → acknowledge      E KeyE → cycleEnvironment
 * `anyActivity = edges.size > 0` (any key edge resets the DSD vigilance timer).
 */
export function keyboardActions(edges: ReadonlySet<string>): InputActions {
  const has = (code: string): boolean => edges.has(code);
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
    cycleEnvironment: has("KeyE"),
    anyActivity: edges.size > 0,
  };
}

/**
 * Gamepad producer: a fixed standard-pad (W3C Standard Gamepad) button/axis map.
 * `buttons` carries EDGE-triggered presses (the impure shell compares to the prior
 * frame so a held button fires one detent, matching the keyboard's no-auto-repeat
 * rule); `axisX` is the raw left-stick horizontal axis (−1 left … +1 right).
 *
 * Standard Gamepad button index map (https://w3c.github.io/gamepad/#dfn-standard-gamepad):
 *   [0]  A / cross       → acknowledge
 *   [1]  B / circle      → emergency
 *   [2]  X / square      → toggleDra
 *   [3]  Y / triangle    → cycleEnvironment
 *   [4]  L1 / LB         → brakeDown
 *   [5]  R1 / RB         → brakeUp
 *   [6]  L2 / LT         → powerDown
 *   [7]  R2 / RT         → powerUp
 *   [12] dpad up         → reverserFwd
 *   [13] dpad down       → reverserRev
 *   [14] dpad left  / axisX ≤ −0.5 → reverserRev (mirror)
 *   [15] dpad right / axisX ≥ +0.5 → reverserOff (mirror)
 * `anyActivity` = any button pressed OR |axisX| > 0.25 (stick deflection counts as
 * activity for the vigilance timer).
 */
export function gamepadActions(buttons: readonly boolean[], axisX: number): InputActions {
  const b = (i: number): boolean => buttons[i] ?? false;
  const left = axisX <= -0.5;
  const right = axisX >= 0.5;
  return {
    powerUp: b(7),
    powerDown: b(6),
    brakeUp: b(5),
    brakeDown: b(4),
    emergency: b(1),
    reverserFwd: b(12),
    reverserOff: b(15) || right,
    reverserRev: b(13) || b(14) || left,
    toggleDra: b(2),
    acknowledge: b(0),
    cycleEnvironment: b(3),
    anyActivity: buttons.some((pressed) => pressed) || Math.abs(axisX) > 0.25,
  };
}
