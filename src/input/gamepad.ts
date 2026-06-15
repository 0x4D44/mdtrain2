// Gamepad source (impure shell). On each `actions()` call it reads
// `navigator.getGamepads()[0]`, edge-detects the buttons (compares to the prior
// frame so a held button fires exactly one detent, matching the keyboard's
// no-auto-repeat rule), reads the left-stick horizontal axis, and hands both to
// the pure `gamepadActions` map. No-op safe: no pad (or no Gamepad API) ⇒
// `NO_ACTIONS`.

import { gamepadActions, NO_ACTIONS, type InputActions } from "./intent";

export interface GamepadSource {
  /** Edge-triggered actions for this frame (NO_ACTIONS if no pad present). */
  actions(): InputActions;
}

export function createGamepadSource(): GamepadSource {
  // Last-frame pressed state, indexed by button. Re-used across frames so the
  // edge detection allocates nothing in steady state.
  const wasPressed: boolean[] = [];
  // Scratch buffer for this frame's edge-triggered presses (re-used).
  const edges: boolean[] = [];

  function actions(): InputActions {
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      return NO_ACTIONS;
    }
    const pad = navigator.getGamepads()[0];
    if (!pad) return NO_ACTIONS;

    const buttons = pad.buttons;
    edges.length = buttons.length;
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const pressed = button ? button.pressed : false;
      const prev = wasPressed[i] ?? false;
      edges[i] = pressed && !prev; // false→true transition = one detent
      wasPressed[i] = pressed;
    }

    const axisX = pad.axes[0] ?? 0;
    return gamepadActions(edges, axisX);
  }

  return { actions };
}
