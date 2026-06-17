// Thin, untested DOM writer for the structured HUD. Builds a fixed-position
// overlay with per-field elements ONCE, then on `update` patches textContent +
// lamp classes. NO control/safety/HUD arithmetic — the projection already
// happened in the pure `buildHudView` (controls.ts); this is the impure adapter.

import type { HudView } from "../sim/controls";
import { safetyPrompt } from "../sim/controls";

export function createHud(parent: HTMLElement): { update(v: HudView): void } {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:14px;top:12px;font:14px/1.6 ui-monospace,monospace;" +
    "color:#cfe0f5;text-shadow:0 1px 2px #000;pointer-events:none;" +
    "display:grid;grid-template-columns:auto auto;gap:1px 12px";

  // Build one value <span> per field; the label is a sibling <span>.
  function row(label: string): HTMLSpanElement {
    const l = document.createElement("span");
    l.textContent = label;
    l.style.opacity = "0.65";
    const v = document.createElement("span");
    root.append(l, v);
    return v;
  }

  function lamp(text: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.cssText =
      "padding:2px 8px;border-radius:3px;border:1px solid #2a3650;color:#5a6a82";
    return s;
  }

  const speed = row("SPEED");
  const limit = row("LIMIT");
  const reverser = row("REVERSER");
  const power = row("POWER");
  const brake = row("BRAKE");
  const brakePct = row("BRK D/A");
  const nextStop = row("NEXT");
  const chainage = row("CHAINAGE");
  const aspect = row("ASPECT");

  // Lamps row spans both columns.
  const lamps = document.createElement("div");
  lamps.style.cssText = "grid-column:1 / 3;margin-top:6px;display:flex;gap:10px";
  const dra = lamp("DRA");
  const dsd = lamp("DSD");
  const penalty = lamp("PENALTY");
  const sunflower = lamp("AWS");
  lamps.append(dra, dsd, penalty, sunflower);
  root.append(lamps);

  // Four-colour aspect lamp colours.
  const ASPECT_COLOUR: Record<HudView["aspect"], string> = {
    RED: "#e04030",
    YELLOW: "#e0b020",
    DOUBLE_YELLOW: "#e0b020",
    GREEN: "#30c050",
  };

  parent.appendChild(root);

  // Prominent centre prompt: shows the pure `safetyPrompt(view)` string when the
  // driver must act (penalty / vigilance), hidden otherwise. One element, driven
  // from the same per-frame `update` below — no new state.
  const prompt = document.createElement("div");
  prompt.id = "mdtrain2-safety-prompt";
  prompt.style.cssText =
    "position:fixed;left:50%;top:34%;transform:translate(-50%,-50%);" +
    "font:700 30px/1.2 ui-monospace,monospace;letter-spacing:0.04em;" +
    "padding:14px 26px;border-radius:8px;text-align:center;white-space:nowrap;" +
    "text-shadow:0 2px 4px #000;pointer-events:none;display:none";
  parent.appendChild(prompt);

  function setLamp(el: HTMLSpanElement, on: boolean, color: string): void {
    if (on) {
      el.style.background = color;
      el.style.color = "#0a0e16";
      el.style.borderColor = color;
    } else {
      el.style.background = "transparent";
      el.style.color = "#5a6a82";
      el.style.borderColor = "#2a3650";
    }
  }

  function update(v: HudView): void {
    speed.textContent = `${v.speedMph.toFixed(0)} mph`;
    limit.textContent = `${v.limitMph.toFixed(0)} mph`;
    reverser.textContent = v.reverser;
    power.textContent = `${v.powerNotch} of ${v.powerMax}`;
    brake.textContent = v.brakeLabel;
    brakePct.textContent = `${v.brakeDemandPct.toFixed(0)}% / ${v.brakeActualPct.toFixed(0)}%`;
    nextStop.textContent = v.nextStop;
    chainage.textContent = `${v.chainage.toFixed(0)} m`;
    aspect.textContent = v.aspect;
    aspect.style.color = ASPECT_COLOUR[v.aspect];

    setLamp(dra, v.dra, "#e0b020"); // amber — DRA set
    setLamp(dsd, v.dsdWarning, "#e0b020"); // amber — DSD warning
    setLamp(penalty, v.penalty, "#e04030"); // red — penalty
    setLamp(sunflower, v.sunflower === "CAUTION", "#e0b020"); // amber — AWS caution latched

    // Centre safety prompt: red+urgent for a penalty, amber for the vigilance
    // warning. `v.penalty` (over dsdWarning) drives the colour to match the
    // selector's precedence.
    const msg = safetyPrompt(v);
    if (msg === null) {
      prompt.style.display = "none";
    } else {
      prompt.textContent = msg;
      prompt.style.display = "block";
      prompt.style.background = v.penalty ? "rgba(160,16,16,0.92)" : "rgba(150,110,0,0.92)";
      prompt.style.color = v.penalty ? "#ffe6e0" : "#fff4d0";
      prompt.style.border = v.penalty ? "2px solid #ff6048" : "2px solid #ffc838";
    }
  }

  return { update };
}
