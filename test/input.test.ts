import { describe, it, expect } from "vitest";
import {
  NO_ACTIONS,
  mergeActions,
  intentFromActions,
  keyboardActions,
  gamepadActions,
  type InputActions,
} from "../src/input/intent";
import type { ControlIntent } from "../src/sim/controls";

// ── Reference oracle ─────────────────────────────────────────────────────────
// A LOCAL copy of the legacy inline `intentFromKeys` from src/main.ts (verbatim).
// REG-INPUT pins the refactor against this so no behaviour changes.
function legacyIntentFromKeys(edgeSet: ReadonlySet<string>): ControlIntent {
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

// The control codes the legacy keymap reads (E is handled separately in main.ts as
// the env-cycle affordance, but keyboardActions folds it into cycleEnvironment).
const MAPPED_CODES = [
  "KeyW",
  "KeyS",
  "KeyD",
  "KeyA",
  "Backquote",
  "KeyF",
  "KeyN",
  "KeyR",
  "KeyL",
  "KeyQ",
  "KeyE",
] as const;

// ── IN1: keyboard map ────────────────────────────────────────────────────────
describe("IN1: keyboardActions maps each code to the correct action", () => {
  const cases: ReadonlyArray<[string, keyof InputActions]> = [
    ["KeyW", "powerUp"],
    ["KeyS", "powerDown"],
    ["KeyD", "brakeUp"],
    ["KeyA", "brakeDown"],
    ["Backquote", "emergency"],
    ["KeyF", "reverserFwd"],
    ["KeyN", "reverserOff"],
    ["KeyR", "reverserRev"],
    ["KeyL", "toggleDra"],
    ["KeyQ", "acknowledge"],
    ["KeyE", "cycleEnvironment"],
  ];

  for (const [code, field] of cases) {
    it(`${code} ⇒ ${field} (and nothing else but anyActivity)`, () => {
      const a = keyboardActions(new Set([code]));
      expect(a[field]).toBe(true);
      expect(a.anyActivity).toBe(true);
      // exactly one control/env field set
      const set = (Object.keys(a) as Array<keyof InputActions>).filter(
        (k) => k !== "anyActivity" && a[k],
      );
      expect(set).toEqual([field]);
    });
  }

  it("empty edge set ⇒ NO_ACTIONS; anyActivity === (edges.size > 0)", () => {
    expect(keyboardActions(new Set())).toEqual(NO_ACTIONS);
    expect(keyboardActions(new Set()).anyActivity).toBe(false);
    expect(keyboardActions(new Set(["KeyW"])).anyActivity).toBe(true);
  });

  it("an unmapped code (KeyZ) sets no control field but still flags activity", () => {
    const a = keyboardActions(new Set(["KeyZ"]));
    expect(a.anyActivity).toBe(true);
    const controls: InputActions = { ...a, anyActivity: false };
    expect(controls).toEqual({ ...NO_ACTIONS, anyActivity: false });
  });
});

// ── IN2: gamepad map ─────────────────────────────────────────────────────────
describe("IN2: gamepadActions maps its fixed button/axis layout", () => {
  const pad = (idx: number): boolean[] => {
    const arr = new Array<boolean>(16).fill(false);
    arr[idx] = true;
    return arr;
  };

  const cases: ReadonlyArray<[number, keyof InputActions]> = [
    [7, "powerUp"],
    [6, "powerDown"],
    [5, "brakeUp"],
    [4, "brakeDown"],
    [1, "emergency"],
    [12, "reverserFwd"],
    [13, "reverserRev"],
    [2, "toggleDra"],
    [0, "acknowledge"],
    [3, "cycleEnvironment"],
  ];

  for (const [idx, field] of cases) {
    it(`buttons[${idx}] ⇒ ${field}`, () => {
      const a = gamepadActions(pad(idx), 0);
      expect(a[field]).toBe(true);
      expect(a.anyActivity).toBe(true);
    });
  }

  it("no buttons + centred axis ⇒ NO_ACTIONS (anyActivity false)", () => {
    expect(gamepadActions([], 0)).toEqual(NO_ACTIONS);
    expect(gamepadActions(new Array<boolean>(16).fill(false), 0)).toEqual(NO_ACTIONS);
  });

  it("axis deflection beyond 0.25 flags activity; mirrors reverser at 0.5", () => {
    const small = gamepadActions(new Array<boolean>(16).fill(false), 0.3);
    expect(small.anyActivity).toBe(true);
    expect(small.reverserOff).toBe(false); // not yet past 0.5

    const right = gamepadActions(new Array<boolean>(16).fill(false), 0.6);
    expect(right.reverserOff).toBe(true);
    const left = gamepadActions(new Array<boolean>(16).fill(false), -0.6);
    expect(left.reverserRev).toBe(true);
  });

  it("guards out-of-range indices safely (short array)", () => {
    expect(() => gamepadActions([true], 0)).not.toThrow();
    const a = gamepadActions([true], 0); // buttons[0] = acknowledge
    expect(a.acknowledge).toBe(true);
    expect(a.powerUp).toBe(false); // index 7 absent, defaults false
  });
});

// ── IN3: merge ───────────────────────────────────────────────────────────────
describe("IN3: mergeActions ORs every field across sources", () => {
  it("mergeActions() with no args === NO_ACTIONS", () => {
    expect(mergeActions()).toEqual(NO_ACTIONS);
  });

  it("ORs fields and anyActivity across multiple sources", () => {
    const kbd = keyboardActions(new Set(["KeyW"])); // powerUp + activity
    const pad = gamepadActions((() => {
      const arr = new Array<boolean>(16).fill(false);
      arr[5] = true; // brakeUp
      return arr;
    })(), 0);
    const merged = mergeActions(kbd, pad);
    expect(merged.powerUp).toBe(true);
    expect(merged.brakeUp).toBe(true);
    expect(merged.anyActivity).toBe(true);
  });

  it("anyActivity true iff at least one source is active", () => {
    const idle = NO_ACTIONS;
    const active = keyboardActions(new Set(["KeyQ"]));
    expect(mergeActions(idle, idle).anyActivity).toBe(false);
    expect(mergeActions(idle, active).anyActivity).toBe(true);
  });

  it("merging a single source is identity", () => {
    const a = keyboardActions(new Set(["KeyF"]));
    expect(mergeActions(a)).toEqual(a);
  });
});

// ── IN4: intentFromActions ───────────────────────────────────────────────────
describe("IN4: intentFromActions fills ControlIntent", () => {
  it("intentFromActions(NO_ACTIONS) is the all-false ControlIntent", () => {
    expect(intentFromActions(NO_ACTIONS)).toEqual({
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
      vigilancePing: false,
    });
  });

  it("a set action lights exactly its intent field; vigilancePing === anyActivity", () => {
    const a: InputActions = { ...NO_ACTIONS, powerUp: true, anyActivity: true };
    const intent = intentFromActions(a);
    expect(intent.powerUp).toBe(true);
    expect(intent.vigilancePing).toBe(true);
    const { powerUp: _p, vigilancePing: _v, ...rest } = intent;
    expect(Object.values(rest).every((x) => x === false)).toBe(true);
  });

  it("cycleEnvironment is NOT carried into ControlIntent", () => {
    const a: InputActions = { ...NO_ACTIONS, cycleEnvironment: true, anyActivity: true };
    const intent = intentFromActions(a);
    expect("cycleEnvironment" in intent).toBe(false);
  });
});

// ── IN5: cycleEnvironment parity (keyboard vs touch) ─────────────────────────
describe("IN5: cycleEnvironment lives on InputActions, shared by devices", () => {
  it("keyboard E and a touch env-button produce the same cycleEnvironment action", () => {
    const fromKey = keyboardActions(new Set(["KeyE"]));
    // A touch env button is just a producer that sets cycleEnvironment + activity.
    const fromTouch: InputActions = { ...NO_ACTIONS, cycleEnvironment: true, anyActivity: true };
    expect(fromKey.cycleEnvironment).toBe(true);
    expect(fromTouch.cycleEnvironment).toBe(true);
    expect(fromKey.cycleEnvironment).toBe(fromTouch.cycleEnvironment);
  });
});

// ── REG-INPUT: provable parity with the legacy keymap ───────────────────────
describe("REG-INPUT: intentFromActions(keyboardActions(e)) === legacyIntentFromKeys(e)", () => {
  // Enumerate many subsets of the mapped codes: empty, all singletons, several
  // pairs, the full set, an unmapped code alone, and KeyE alone.
  function subsets(): Array<ReadonlySet<string>> {
    const out: Array<ReadonlySet<string>> = [];
    out.push(new Set()); // empty
    for (const c of MAPPED_CODES) out.push(new Set([c])); // singletons
    // all adjacent pairs + a few cross pairs
    for (let i = 0; i < MAPPED_CODES.length; i++) {
      for (let j = i + 1; j < MAPPED_CODES.length; j++) {
        const a = MAPPED_CODES[i];
        const b = MAPPED_CODES[j];
        if (a !== undefined && b !== undefined) out.push(new Set([a, b]));
      }
    }
    out.push(new Set(MAPPED_CODES)); // everything at once
    out.push(new Set(["KeyZ"])); // unmapped code alone
    out.push(new Set(["KeyZ", "KeyW"])); // unmapped + mapped
    out.push(new Set(["KeyE"])); // env-cycle alone
    return out;
  }

  it("deep-equals over many subsets", () => {
    let checked = 0;
    for (const edges of subsets()) {
      const refactored = intentFromActions(keyboardActions(edges));
      const legacy = legacyIntentFromKeys(edges);
      expect(refactored).toEqual(legacy);
      checked++;
    }
    // sanity: empty + 11 singletons + 55 pairs + full + 2 unmapped + KeyE
    expect(checked).toBe(1 + 11 + 55 + 1 + 2 + 1);
  });
});
