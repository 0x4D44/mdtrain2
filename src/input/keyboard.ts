// Keyboard edge source (impure shell). Owns the window keydown/keyup/blur
// listeners and the per-frame edge `Set` of just-pressed key codes that used to
// live inline in `main.ts`. The pure code-→-action mapping stays in
// `keyboardActions` (src/input/intent.ts); this file is pure plumbing.
//
// keydown ignores auto-repeat so a hold never re-fires a detent; keyup/blur are
// housekeeping. The frame drains the set via `edges()` then calls `clear()`.

export interface KeyboardSource {
  /** The set of key codes pressed (edge) since the last `clear()`. */
  edges(): ReadonlySet<string>;
  /** Empty the edge set (call once at the end of each frame). */
  clear(): void;
}

export function createKeyboardSource(): KeyboardSource {
  const edges = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    edges.add(e.code);
  });
  window.addEventListener("keyup", (e) => edges.delete(e.code));
  window.addEventListener("blur", () => edges.clear());
  return {
    edges: () => edges,
    clear: () => edges.clear(),
  };
}
