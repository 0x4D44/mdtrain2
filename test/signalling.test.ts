import { describe, it, expect } from "vitest";
import type { Aspect, Route } from "../src/sim/route";
import {
  aspectAt,
  nextSignalAhead,
  pointsCrossedFwd,
  STARTER_OFFSET,
} from "../src/sim/route";
import { STAND_EPS } from "../src/sim/controls";

// ── Fixtures & local helpers ─────────────────────────────────────────────────

/** Legacy front offset (m), pinned by the HLD (§2.3); `aws.ts` re-exports it in
 *  WI-2. WI-1's geometry oracles use the value directly. */
const FRONT_OFFSET = 2.0;

/**
 * The §2.1 / §2.5 three-starter synthetic route: S1@1620/Riverside,
 * S2@3220/City Centre, S3@4520/Victoria Street, with the matching station stop
 * boards (1500/3100/4400) and their platformHalf, length 6000. No block
 * signals. Grades/limits/curvatures are minimal — only chainage geometry
 * matters to the signalling oracles. (`aspectAt`/`nextSignalAhead`/the crossing
 * queries all run against this.)
 */
function aspectRoute(): Route {
  return {
    length: 6_000,
    stations: [
      { name: "Westford", chainage: 0, platformHalf: 90 },
      { name: "Riverside", chainage: 1_500, platformHalf: 90 },
      { name: "City Centre", chainage: 3_100, platformHalf: 100 },
      { name: "Victoria Street", chainage: 4_400, platformHalf: 90 },
      { name: "Eastbank", chainage: 6_000, platformHalf: 90 },
    ],
    grades: [{ from: 0, to: 6_000, value: 0 }],
    speedLimits: [{ from: 0, to: 6_000, value: 20 }],
    curvatures: [{ from: 0, to: 6_000, value: 0 }],
    signals: [
      { chainage: 1_620, protects: "Riverside" },
      { chainage: 3_220, protects: "City Centre" },
      { chainage: 4_520, protects: "Victoria Street" },
    ],
  };
}

/** A signal-free route (mirrors the Phase-0/1 synthetic fixtures). */
function emptyRoute(): Route {
  return {
    length: 6_000,
    stations: [],
    grades: [{ from: 0, to: 6_000, value: 0 }],
    speedLimits: [{ from: 0, to: 6_000, value: 20 }],
    curvatures: [{ from: 0, to: 6_000, value: 0 }],
    signals: [],
  };
}

/**
 * The HUD aspect derivation from §2.6: the aspect of the next signal ahead in
 * `dir` over the served-set, falling back to GREEN when nothing is ahead (which
 * includes reverse running, where `nextSignalAhead(dir=-1)` returns null). This
 * is the pure substrate `buildHudView` will compute in WI-2.
 */
function hudAspect(route: Route, s: number, dir: 1 | -1, served: ReadonlySet<string>): Aspect {
  const ahead = nextSignalAhead(route, s, dir);
  return ahead ? aspectAt(route, ahead.i, served) : "GREEN";
}

/** Does an at-stand rest at `chainage` serve the station with stop board
 *  `board`/half-length `platformHalf`? The served-writer proxy (§2.3 step 1):
 *  |speed| ≤ STAND_EPS and the FRONT (= chainage + FRONT_OFFSET) within
 *  ±platformHalf of the board. */
function servesAtStand(
  chainage: number,
  speed: number,
  board: number,
  platformHalf: number,
): boolean {
  if (Math.abs(speed) > STAND_EPS) return false;
  const front = chainage + FRONT_OFFSET;
  return Math.abs(front - board) <= platformHalf;
}

/** The signal-post chainages of a route, index-aligned with route.signals. */
function posts(route: Route): number[] {
  return route.signals.map((sig) => sig.chainage);
}

// Convenience served-sets over the three starters' stations.
const ALL_SERVED = new Set(["Riverside", "City Centre", "Victoria Street"]);

// ── A — aspect cascade (aspectAt, train-free; 3-starter adjacent cascade) ─────

describe("oracle A1: only S3 unserved ⇒ S3 RED, S2 YELLOW, S1 DOUBLE_YELLOW", () => {
  it("one rung per starter; double-yellow reachable across the S1→S2 long run", () => {
    const route = aspectRoute();
    const served = new Set(["Riverside", "City Centre"]); // S3's station unserved
    expect(aspectAt(route, 2, served)).toBe("RED"); // S3 own held-red
    expect(aspectAt(route, 1, served)).toBe("YELLOW"); // S2 one rung behind RED
    expect(aspectAt(route, 0, served)).toBe("DOUBLE_YELLOW"); // S1 two rungs behind
  });
});

describe("oracle A2: every station served ⇒ all three starters GREEN", () => {
  it("nothing held red ⇒ clear line", () => {
    const route = aspectRoute();
    expect(aspectAt(route, 0, ALL_SERVED)).toBe("GREEN");
    expect(aspectAt(route, 1, ALL_SERVED)).toBe("GREEN");
    expect(aspectAt(route, 2, ALL_SERVED)).toBe("GREEN");
  });
});

describe("oracle A3: only S2 unserved ⇒ S2 RED, S1 YELLOW, S3 GREEN", () => {
  it("single-step caution behind an isolated red; ahead-served stays GREEN", () => {
    const route = aspectRoute();
    const served = new Set(["Riverside", "Victoria Street"]); // S2's station unserved
    expect(aspectAt(route, 1, served)).toBe("RED"); // S2 own held-red
    expect(aspectAt(route, 0, served)).toBe("YELLOW"); // S1 immediately behind
    expect(aspectAt(route, 2, served)).toBe("GREEN"); // S3 ahead, served
  });
});

describe("oracle A4: last starter with nothing ahead — no out-of-range read", () => {
  it("returns only its own RED/GREEN (noUncheckedIndexedAccess guard + termination)", () => {
    const route = aspectRoute();
    // S3 unserved ⇒ own held-red, no look-ahead read past the end.
    expect(aspectAt(route, 2, new Set())).toBe("RED");
    // S3 served, nothing ahead ⇒ GREEN (the guarded i+1 read returns undefined).
    expect(aspectAt(route, 2, new Set(["Victoria Street"]))).toBe("GREEN");
    // Reading at/past the end never throws and yields the GREEN guard.
    expect(aspectAt(route, 3, ALL_SERVED)).toBe("GREEN");
    expect(aspectAt(route, 99, new Set())).toBe("GREEN");
  });
});

describe("oracle A-EMPTY: signal-free route never throws; HUD GREEN", () => {
  it("aspectAt/nextSignalAhead are safe and nextSignalAhead → null ⇒ HUD GREEN", () => {
    const route = emptyRoute();
    expect(() => aspectAt(route, 0, new Set())).not.toThrow();
    expect(aspectAt(route, 0, new Set())).toBe("GREEN");
    expect(nextSignalAhead(route, 0, 1)).toBeNull();
    expect(nextSignalAhead(route, 5_000, 1)).toBeNull();
    expect(hudAspect(route, 0, 1, new Set())).toBe("GREEN");
  });
});

describe("oracle A-SPAWN: starter-less origin ⇒ no aspect effect, HUD GREEN", () => {
  it("at spawn, served may contain Westford; the cascade default holds, HUD GREEN", () => {
    const route = aspectRoute();
    // Serving the starter-less origin only clears the sunflower — no signal
    // protects Westford, so it never enters any aspect computation.
    const served = new Set(["Westford"]);
    // At spawn (chainage 0), the signal ahead is S1; with Riverside unserved it
    // is RED — but the HUD reads GREEN at chainage 0 only if no signal is ahead.
    // Here S1 IS ahead and RED: serving Westford does not clear it.
    expect(nextSignalAhead(route, 0, 1)).toEqual({ i: 0, sig: route.signals[0] });
    expect(aspectAt(route, 0, served)).toBe("RED"); // Riverside still unserved
    // Westford in `served` is idempotent for aspects: identical to empty set.
    expect(aspectAt(route, 0, served)).toBe(aspectAt(route, 0, new Set()));
    expect(aspectAt(route, 1, served)).toBe(aspectAt(route, 1, new Set()));
    expect(aspectAt(route, 2, served)).toBe(aspectAt(route, 2, new Set()));
  });
});

describe("oracle A-REVERSE: reverse running shows decorative GREEN", () => {
  it("nextSignalAhead(dir=-1) === null ⇒ HUD aspect GREEN (signals face forward)", () => {
    const route = aspectRoute();
    // Even sitting right behind a held-RED starter, reverse running sees nothing
    // ahead and the HUD shows GREEN.
    expect(nextSignalAhead(route, 1_600, -1)).toBeNull();
    expect(nextSignalAhead(route, 0, -1)).toBeNull();
    expect(hudAspect(route, 1_600, -1, new Set())).toBe("GREEN");
  });
});

// ── D — TPWS TSS / SPAD geometry (pure: pointsCrossedFwd + aspectAt + served) ─

describe("oracle D1: TSS on an unserved red — forward crossing of a RED starter", () => {
  it("front crosses S1's post while Riverside is unserved ⇒ a SPAD crossing (RED)", () => {
    const route = aspectRoute();
    const served = new Set<string>(); // Riverside unserved ⇒ S1 RED
    const sPrev = 1_600;
    const sNow = 1_640; // sweeps the S1 post at 1620
    const crossed = pointsCrossedFwd(posts(route), sPrev, sNow);
    expect(crossed).toContain(0); // S1's post crossed forward
    // The crossing is RED (station unserved) ⇒ this is the blow-through/TSS/SPAD.
    for (const i of crossed) expect(aspectAt(route, i, served)).toBe("RED");
  });
});

describe("oracle D1-SERVED: a normal served stop is SPAD-free (keystone)", () => {
  it("serve the station, then depart across the post ⇒ a non-RED crossing", () => {
    const route = aspectRoute();
    // Run for each of the three starters.
    const cases: { board: number; half: number; station: string; post: number; i: number }[] = [
      { board: 1_500, half: 90, station: "Riverside", post: 1_620, i: 0 },
      { board: 3_100, half: 100, station: "City Centre", post: 3_220, i: 1 },
      { board: 4_400, half: 90, station: "Victoria Street", post: 4_520, i: 2 },
    ];
    for (const c of cases) {
      // (1) A legal stop within the platform serves the station at a stand.
      const rest = c.board; // rest the front near the board (chainage = board)
      expect(servesAtStand(rest, 0, c.board, c.half)).toBe(true);
      const served = new Set([c.station]); // serving clears THIS starter's RED
      // (2) Depart across the post: the front sweeps the post.
      const sPrev = c.post - FRONT_OFFSET - 5;
      const sNow = c.post + FRONT_OFFSET + 5;
      const crossed = pointsCrossedFwd(posts(route), sPrev, sNow);
      expect(crossed).toContain(c.i);
      // The keystone SPAD predicate (§2.3 step 4): TSS/SPAD fires only on a RED
      // crossing. Serving the station clears its held-RED, so the crossing is
      // NOT RED ⇒ no TSS/SPAD on a normal stop (YELLOW if a later stop is still
      // ahead is still SPAD-free).
      for (const i of crossed) expect(aspectAt(route, i, served)).not.toBe("RED");
    }
    // The clean GREEN case: with the whole line served, every post is GREEN.
    for (const c of cases) {
      expect(aspectAt(route, c.i, ALL_SERVED)).toBe("GREEN");
    }
  });
});

describe("oracle D-OVERSHOOT: the serve window is SPAD-free across all three starters", () => {
  it("every legal rest chainage serves, then departs across a GREEN post (R3-4/F4)", () => {
    const route = aspectRoute();
    const cases: { board: number; half: number; station: string; post: number; i: number }[] = [
      { board: 1_500, half: 90, station: "Riverside", post: 1_620, i: 0 },
      { board: 3_100, half: 100, station: "City Centre", post: 3_220, i: 1 },
      { board: 4_400, half: 90, station: "Victoria Street", post: 4_520, i: 2 },
    ];
    for (const c of cases) {
      // Sweep rest CHAINAGE over [board − platformHalf, board + platformHalf −
      // FRONT_OFFSET] so the front (= chainage + FRONT_OFFSET) stays within
      // ±platformHalf of the board.
      const lo = c.board - c.half;
      const hi = c.board + c.half - FRONT_OFFSET;
      for (let rest = lo; rest <= hi + 1e-9; rest += 5) {
        // (a) the rest serves at the stand (front within ±platformHalf).
        expect(servesAtStand(rest, 0, c.board, c.half)).toBe(true);
        // (b) on departure the front crosses the post with no SPAD: serving the
        // station cleared its held-RED, so the crossing is NOT RED.
        const served = new Set([c.station]);
        const front = rest + FRONT_OFFSET;
        // The furthest-forward legal front (= board + platformHalf) is still
        // short of the post − FRONT_OFFSET (the keystone inequality).
        expect(front).toBeLessThan(c.post - FRONT_OFFSET + 1e-9);
        const crossed = pointsCrossedFwd(posts(route), front, c.post + 1);
        expect(crossed).toContain(c.i);
        for (const k of crossed) expect(aspectAt(route, k, served)).not.toBe("RED");
      }
      // Pin the keystone inequality at the true upper bound (front = board+half).
      expect(c.board + c.half).toBeLessThan(c.post - FRONT_OFFSET);
    }
  });
});

describe("oracle D2: reverse running over the same red geometry — no crossing", () => {
  it("reverse sweep (sNow < sPrev) crosses nothing ⇒ no TSS/SPAD (strict-forward gate)", () => {
    const route = aspectRoute();
    // Same unserved geometry as D1 (S1 RED), but reversing back across the post.
    const sPrev = 1_640;
    const sNow = 1_600; // sNow < sPrev ⇒ reverse
    expect(pointsCrossedFwd(posts(route), sPrev, sNow)).toEqual([]);
    // Standing (sNow === sPrev) also crosses nothing.
    expect(pointsCrossedFwd(posts(route), 1_620, 1_620)).toEqual([]);
  });
});

// Belt: STARTER_OFFSET is the geometry constant the posts are authored from.
describe("route authoring: starter posts = board + STARTER_OFFSET", () => {
  it("the three posts derive from their stop boards", () => {
    const route = aspectRoute();
    expect(route.signals[0]?.chainage).toBe(1_500 + STARTER_OFFSET);
    expect(route.signals[1]?.chainage).toBe(3_100 + STARTER_OFFSET);
    expect(route.signals[2]?.chainage).toBe(4_400 + STARTER_OFFSET);
  });
});
