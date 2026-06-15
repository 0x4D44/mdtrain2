// Touch controls (impure DOM/CSS shell). Builds a fixed-position overlay of real
// <button> elements (focusable, ARIA-labelled) shown only on coarse-pointer or
// narrow viewports. A pointerdown on a button sets a one-frame edge for that
// action; `actions()` returns the accumulated edges and clears them — so each tap
// is a single detent, mirroring the keyboard's no-auto-repeat rule.
//
// The CSS lives in a <style> tag injected once; a media query toggles the
// overlay's `display` so the desktop screenshot is unchanged.

import { NO_ACTIONS, type InputActions } from "./intent";

export interface TouchControls {
  /** Actions accumulated since the last call (then cleared). */
  actions(): InputActions;
}

const STYLE_ID = "mdtrain2-touch-style";
const CONTAINER_ID = "mdtrain2-touch";

// The boolean action fields a touch button can set (everything except the
// derived `anyActivity`, which we compute from whether any button was tapped).
type TouchAction = Exclude<keyof InputActions, "anyActivity">;

interface ButtonSpec {
  action: TouchAction;
  label: string; // aria-label
  text: string; // visible glyph/text
}

const BUTTONS: readonly ButtonSpec[] = [
  { action: "powerUp", label: "Power up", text: "PWR +" },
  { action: "powerDown", label: "Power down", text: "PWR −" },
  { action: "brakeUp", label: "Brake up", text: "BRK +" },
  { action: "brakeDown", label: "Brake down", text: "BRK −" },
  { action: "reverserFwd", label: "Reverser forward", text: "REV F" },
  { action: "reverserOff", label: "Reverser neutral", text: "REV N" },
  { action: "reverserRev", label: "Reverser reverse", text: "REV R" },
  { action: "toggleDra", label: "Driver's reminder appliance", text: "DRA" },
  { action: "acknowledge", label: "Acknowledge", text: "ACK" },
  { action: "emergency", label: "Emergency brake", text: "EMERGENCY" },
  { action: "cycleEnvironment", label: "Cycle environment", text: "ENV" },
];

const CSS = `
#${CONTAINER_ID} {
  display: none;
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  padding: 8px;
  box-sizing: border-box;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  pointer-events: none;
}
#${CONTAINER_ID} button {
  pointer-events: auto;
  min-height: 56px;
  padding: 8px 6px;
  font: 600 13px/1.1 system-ui, sans-serif;
  letter-spacing: 0.02em;
  color: #cfe0ff;
  background: rgba(12, 18, 30, 0.82);
  border: 1px solid rgba(120, 150, 200, 0.5);
  border-radius: 8px;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
}
#${CONTAINER_ID} button:active {
  background: rgba(40, 70, 120, 0.92);
}
#${CONTAINER_ID} button[data-action="emergency"] {
  grid-column: span 2;
  color: #ffd2cf;
  border-color: rgba(220, 90, 80, 0.7);
}
@media (pointer: coarse), (max-width: 760px) {
  #${CONTAINER_ID} { display: grid; }
}
`;

function injectStyleOnce(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function createTouchControls(parent: HTMLElement): TouchControls {
  injectStyleOnce();

  // Accumulated edges for the current frame, keyed by action.
  const pending: Record<TouchAction, boolean> = {
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
  };

  const container = document.createElement("div");
  container.id = CONTAINER_ID;

  for (const spec of BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = spec.text;
    btn.setAttribute("aria-label", spec.label);
    btn.dataset["action"] = spec.action;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // discrete tap; suppress synthetic mouse/scroll
      pending[spec.action] = true;
    });
    container.appendChild(btn);
  }

  parent.appendChild(container);

  function actions(): InputActions {
    let any = false;
    const out: InputActions = { ...NO_ACTIONS };
    for (const spec of BUTTONS) {
      if (pending[spec.action]) {
        out[spec.action] = true;
        any = true;
        pending[spec.action] = false; // consume the edge
      }
    }
    out.anyActivity = any;
    return out;
  }

  return { actions };
}
