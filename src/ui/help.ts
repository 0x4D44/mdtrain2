// Controls help panel (impure DOM/CSS shell). A fixed top-right card listing the
// keyboard controls, shown by default and toggled with the H key (or its own
// close button). Self-contained: it owns its toggle listener and styles, so the
// sim/input core is untouched. Untested DOM adapter, like hud.ts / touch.ts.

const STYLE_ID = "mdtrain2-help-style";
const PANEL_ID = "mdtrain2-help";

interface Row {
  keys: string; // glyphs for the key(s)
  what: string; // what it does
}

const ROWS: readonly Row[] = [
  { keys: "W / S", what: "Power up / down" },
  { keys: "D / A", what: "Brake on / off" },
  { keys: "F / N / R", what: "Reverser fwd / neutral / rev" },
  { keys: "Q", what: "Acknowledge AWS / reset penalty" },
  { keys: "L", what: "DRA (driver's reminder)" },
  { keys: "`", what: "Emergency brake" },
  { keys: "E", what: "Change weather / time of day" },
  { keys: "H", what: "Show / hide this panel" },
];

const CSS = `
#${PANEL_ID} {
  position: fixed;
  top: 12px;
  right: 14px;
  z-index: 20;
  max-width: 280px;
  padding: 10px 12px;
  font: 12px/1.5 ui-monospace, monospace;
  color: #cfe0f5;
  background: rgba(8, 12, 20, 0.7);
  border: 1px solid rgba(120, 150, 200, 0.4);
  border-radius: 8px;
  text-shadow: 0 1px 2px #000;
  pointer-events: auto;
  user-select: none;
}
#${PANEL_ID}[hidden] { display: none; }
#${PANEL_ID} h2 {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.7;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#${PANEL_ID} .x {
  cursor: pointer;
  opacity: 0.6;
  padding: 0 4px;
  font-size: 14px;
}
#${PANEL_ID} .x:hover { opacity: 1; }
#${PANEL_ID} table { border-collapse: collapse; }
#${PANEL_ID} td { padding: 1px 0; vertical-align: top; }
#${PANEL_ID} td.k {
  padding-right: 12px;
  color: #9fd0ff;
  white-space: nowrap;
}
#${PANEL_ID} .hint { margin-top: 7px; opacity: 0.5; font-size: 11px; }
@media (pointer: coarse) { #${PANEL_ID} { display: none; } }
`;

function injectStyleOnce(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface HelpPanel {
  toggle(): void;
}

/**
 * Build the help panel and wire its toggle (H key + close button). Visible by
 * default on keyboard devices; the CSS hides it on coarse-pointer (touch) where
 * the on-screen buttons are self-labelling.
 */
export function createHelpPanel(parent: HTMLElement): HelpPanel {
  injectStyleOnce();

  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const h = document.createElement("h2");
  h.textContent = "Controls";
  const close = document.createElement("span");
  close.className = "x";
  close.textContent = "×";
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", "Hide controls (H)");
  h.appendChild(close);
  panel.appendChild(h);

  const table = document.createElement("table");
  for (const row of ROWS) {
    const tr = document.createElement("tr");
    const k = document.createElement("td");
    k.className = "k";
    k.textContent = row.keys;
    const v = document.createElement("td");
    v.textContent = row.what;
    tr.append(k, v);
    table.appendChild(tr);
  }
  panel.appendChild(table);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "press H to hide";
  panel.appendChild(hint);

  parent.appendChild(panel);

  function toggle(): void {
    panel.hidden = !panel.hidden;
  }

  close.addEventListener("click", toggle);
  // Own the toggle key directly (H is not a train control, so it never reaches
  // the sim input model). Ignore auto-repeat so a hold toggles once.
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyH" && !e.repeat) toggle();
  });

  return { toggle };
}
