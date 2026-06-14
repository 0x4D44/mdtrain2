import { describe, it, expect } from "vitest";
import type { Aspect, Route } from "../src/sim/route";
import {
  aspectAt,
  nextSignalAhead,
  pointsCrossedFwd,
  STARTER_OFFSET,
} from "../src/sim/route";
import type { ControlIntent, PenaltyReason, SafetyState } from "../src/sim/controls";
import {
  STAND_EPS,
  createInitialSafety,
  resolveInputs,
  tickSafety,
} from "../src/sim/controls";
import type { AwsHud, AwsState } from "../src/sim/aws";
import {
  AWS_MAGNET_OFFSET,
  OSS_LOOP_OFFSET,
  OSS_TRIP_SPEED,
  createInitialAws,
  tickAws,
} from "../src/sim/aws";
import { ADHESION } from "../src/sim/train";
import type { SimState } from "../src/sim/simulation";

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

// ── tickAws driver helpers ───────────────────────────────────────────────────

const FRONT = FRONT_OFFSET; // alias for geometry below

/** Every edge false — the base intent; spread-override what a test wants. */
function noIntent(): ControlIntent {
  return {
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
  };
}

function intent(over: Partial<ControlIntent>): ControlIntent {
  return { ...noIntent(), ...over };
}

/** One leg of an `awsFor` drive: the front sweeps `prev → now` at `speed`. */
interface Seg {
  prev: number; // prevChainage
  now: number; // state.chainage
  speed: number; // m/s (signed); |speed| ≤ STAND_EPS ⇒ a stand
}

interface AwsForOpts {
  dir?: 1 | -1;
  dt?: number;
  /** Intent for tick `t` (0-based). Default: noIntent. */
  intentPerTick?: (t: number) => ControlIntent;
  /** Optional non-initial seed (e.g. a mid-countdown WARNING for G1). */
  seed?: AwsState;
}

/**
 * Advance an `AwsState` across `segments`, threading prevChainage → chainage and
 * aws ← next (§2.5 `awsFor`). Seeds `createInitialAws()` (or `opts.seed`), then
 * per segment calls `tickAws(aws, {…chainage,speed…}, route, intentPerTick(t),
 * prev, dir, dt)`. Returns the FINAL `{aws, reasons, hud}`.
 */
function awsFor(
  route: Route,
  segments: Seg[],
  opts: AwsForOpts = {},
): { aws: AwsState; reasons: PenaltyReason[]; hud: AwsHud } {
  const dir = opts.dir ?? 1;
  const dt = opts.dt ?? 1 / 60;
  const intentPerTick = opts.intentPerTick ?? (() => noIntent());
  let aws = opts.seed ?? createInitialAws();
  let reasons: PenaltyReason[] = [];
  let hud: AwsHud = { sunflower: aws.sunflower, spad: aws.spad };
  segments.forEach((seg, t) => {
    const state: SimState = { chainage: seg.now, speed: seg.speed, brakeActual: 1, time: 0 };
    const o = tickAws(aws, state, route, intentPerTick(t), seg.prev, dir, dt);
    aws = o.next;
    reasons = o.reasons;
    hud = o.hud;
  });
  return { aws, reasons, hud };
}

/** A forward leg at a moving speed (default 8 m/s, below OSS trip). */
function leg(prev: number, now: number, speed = 8): Seg {
  return { prev, now, speed };
}
/** A standing leg (front rests at `chainage`). */
function stand(chainage: number): Seg {
  return { prev: chainage, now: chainage, speed: 0 };
}

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

  it("(machine) serving starter-less Westford yields no reason — a standing spawn tick", () => {
    const route = aspectRoute();
    // At spawn the train stands at the starter-less origin. tickAws serves
    // Westford (no signal protects it) and produces no penalty reason.
    const out = awsFor(route, [stand(0)], {
      dt: 1 / 60,
      seed: { ...createInitialAws(), served: new Set(["Westford"]) },
    });
    expect(out.aws.served.has("Westford")).toBe(true);
    expect(out.reasons).toEqual([]); // serving a starter-less station ⇒ no reason
    expect(out.aws.brakeReason).toBeNull();
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

// ── S1 geometry (Riverside), used by the tickAws machine oracles ─────────────
// post 1620, magnet = post − 180 = 1440, OSS loop = post − 50 = 1570, board 1500
// (platformHalf 90). FRONT = 2.0: a leg crosses the magnet when chainage sweeps
// past magnet − FRONT (= 1438).
const S1_POST = 1_620;
const S1_MAGNET = S1_POST - AWS_MAGNET_OFFSET; // 1440
const S1_OSS = S1_POST - OSS_LOOP_OFFSET; // 1570
// A leg whose front (chainage + FRONT) sweeps just past the S1 magnet.
function crossS1Magnet(speed = 8): Seg {
  return { prev: S1_MAGNET - FRONT - 1, now: S1_MAGNET - FRONT + 1, speed }; // front 1439→1441
}

// ── B — AWS warning machine (awsFor) ─────────────────────────────────────────

describe("oracle B1: in-window ack clears the WARNING while moving (no reason)", () => {
  it("magnet ⇒ WARNING + CAUTION; ack in motion ⇒ CLEAR, sunflower latched, []", () => {
    const route = aspectRoute();
    // Tick 0: cross the magnet. Tick 1: ack while still moving, within the window.
    const out = awsFor(route, [crossS1Magnet(8), leg(S1_MAGNET + 2, S1_MAGNET + 4, 8)], {
      dt: 0.2,
      intentPerTick: (t) => (t === 1 ? intent({ acknowledge: true }) : noIntent()),
    });
    expect(out.aws.phase).toBe("CLEAR");
    expect(out.aws.sunflower).toBe("CAUTION"); // latched reminder stays
    expect(out.aws.brakeReason).toBeNull();
    expect(out.reasons).toEqual([]);
  });

  it("a single magnet tick alone leaves WARNING + CAUTION, no reason", () => {
    const route = aspectRoute();
    const out = awsFor(route, [crossS1Magnet(8)], { dt: 0.2 });
    expect(out.aws.phase).toBe("WARNING");
    expect(out.aws.sunflower).toBe("CAUTION");
    expect(out.reasons).toEqual([]);
  });
});

describe("oracle B2: no ack within the window ⇒ AWS penalty brake", () => {
  it("cross magnet, run > AWS_WARN_WINDOW with no ack ⇒ brakeReason AWS, reasons [AWS]", () => {
    const route = aspectRoute();
    // Magnet leg, then countdown legs creeping forward (well short of OSS/post).
    const segs: Seg[] = [crossS1Magnet(8)];
    for (let k = 0; k < 8; k++) segs.push(leg(1_443 + k, 1_444 + k, 8)); // 4.0 s @ dt 0.5
    const out = awsFor(route, segs, { dt: 0.5 });
    expect(out.aws.brakeReason).toBe("AWS");
    expect(out.reasons).toContain("AWS");
    // Through the latch + resolveInputs: full-service brake, not emergency.
    const s = foldThroughLatch(out.reasons, 8 /* moving */);
    const inputs = resolveInputs(
      { powerNotch: 0, brakeStep: 0, reverser: "FWD", lastDir: 1, dra: false },
      s,
      ADHESION.wetNight,
    );
    expect(inputs.brake).toBe(1);
    expect(inputs.emergency).toBe(false);
  });
});

describe("oracle B3: serving a station rings the clear bell ⇒ sunflower BLACK", () => {
  it("from a CAUTION-latched CLEAR, a served stand resets the sunflower", () => {
    const route = aspectRoute();
    // Cross the magnet (CAUTION), ack to CLEAR (still CAUTION), then stand within
    // Riverside's platform (board 1500 ± 90) to serve it.
    const segs: Seg[] = [
      crossS1Magnet(8), // WARNING + CAUTION
      leg(S1_MAGNET + 2, S1_MAGNET + 4, 8), // ack → CLEAR, sunflower still CAUTION
      stand(1_498), // front 1500 == board ⇒ serves Riverside ⇒ BLACK
    ];
    const out = awsFor(route, segs, {
      dt: 0.2,
      intentPerTick: (t) => (t === 1 ? intent({ acknowledge: true }) : noIntent()),
    });
    expect(out.aws.sunflower).toBe("BLACK");
    expect(out.aws.served.has("Riverside")).toBe(true);
    expect(out.aws.phase).toBe("CLEAR");
  });
});

describe("oracle B3-serve-cancels: serving cancels an outstanding AWS WARNING (F2)", () => {
  it("cross magnet ⇒ WARNING; stop within the platform to serve ⇒ phase CLEAR, no AWS penalty", () => {
    const route = aspectRoute();
    // Cross the S1 magnet (arms WARNING, warnTimer = AWS_WARN_WINDOW = 3), then
    // come to a stand within Riverside's platform (board 1500 ± 90) to serve it
    // — WITHOUT acking. Serving turns S1 GREEN, so the AWS warning must cancel.
    const segs: Seg[] = [
      crossS1Magnet(8), // WARNING + CAUTION, warnTimer = 3
      stand(1_498), // front 1500 == board ⇒ serves Riverside
    ];
    const out = awsFor(route, segs, { dt: 0.2 });
    expect(out.aws.served.has("Riverside")).toBe(true);
    expect(out.aws.phase).toBe("CLEAR"); // warning cancelled by the serve
    expect(out.aws.warnTimer).toBe(0);
    expect(out.aws.brakeReason).toBeNull();
    expect(out.reasons).toEqual([]); // no AWS penalty raised ~3 s later

    // Belt: keep ticking at the stand past where warnTimer would have hit 0 — no
    // penalty ever materialises (the warning is gone, not merely paused).
    let aws = out.aws;
    for (let k = 0; k < 6; k++) {
      const o = tickAws(aws, { chainage: 1_498, speed: 0, brakeActual: 1, time: 0 }, route, noIntent(), 1_498, 1, 1.0);
      aws = o.next;
      expect(o.reasons).toEqual([]);
      expect(aws.brakeReason).toBeNull();
    }
  });
});

describe("oracle B4: a latched brake outranks a fresh non-GREEN magnet", () => {
  it("braked, then re-cross the magnet ⇒ brakeReason unchanged, phase not WARNING", () => {
    const route = aspectRoute();
    // Reach braked via a RED-post SPAD crossing (front sweeps the S1 post, RED).
    const segs: Seg[] = [{ prev: S1_POST - FRONT - 1, now: S1_POST - FRONT + 1, speed: 8 }];
    // Then a later forward leg re-crossing the magnet (still non-GREEN).
    segs.push(crossS1Magnet(8));
    const out = awsFor(route, segs, { dt: 0.2 });
    expect(out.aws.brakeReason).toBe("TPWS"); // the SPAD latch
    expect(out.aws.phase).not.toBe("WARNING"); // the fresh magnet cannot re-arm WARNING
  });
});

describe("oracle B5: GREEN-magnet branch (re-passing a served starter's magnet)", () => {
  const route = aspectRoute();
  // S1 is GREEN only when its station AND everything ahead are served (the
  // cascade looks ahead), so seed the whole line as served. Re-cross the (now
  // GREEN) S1 magnet.
  const served = ALL_SERVED;
  function seed(over: Partial<AwsState>): AwsState {
    return { ...createInitialAws(), served, ...over };
  }

  it("(a) CAUTION + CLEAR ⇒ GREEN magnet rings the bell ⇒ BLACK", () => {
    const out = awsFor(route, [crossS1Magnet(8)], {
      dt: 0.2,
      seed: seed({ sunflower: "CAUTION", phase: "CLEAR" }),
    });
    expect(out.aws.sunflower).toBe("BLACK");
    expect(out.aws.phase).toBe("CLEAR");
  });

  it("(b) WARNING ⇒ GREEN magnet cancels to CLEAR and rings the bell ⇒ BLACK", () => {
    const out = awsFor(route, [crossS1Magnet(8)], {
      dt: 0.2,
      seed: seed({ sunflower: "CAUTION", phase: "WARNING", warnTimer: 2 }),
    });
    expect(out.aws.phase).toBe("CLEAR");
    expect(out.aws.sunflower).toBe("BLACK");
  });

  it("(c) a latched BRAKE is untouched by the GREEN magnet (F6 guard)", () => {
    const out = awsFor(route, [crossS1Magnet(8)], {
      dt: 0.2,
      seed: seed({ brakeReason: "AWS" }),
    });
    expect(out.aws.brakeReason).toBe("AWS"); // GREEN magnet does not clear a brake
  });
});

// ── C — penalty lifecycle through the DSD-scoped seed (latch keystone) ───────

/** Fold `reasons` through `tickSafety` from a clean safety, at the given speed.
 *  Mirrors the frame: tickSafety seeds DSD-only and folds `aws.reasons` (:275). */
function foldThroughLatch(reasons: PenaltyReason[], speed: number, prior?: SafetyState): SafetyState {
  const base = prior ?? createInitialSafety();
  const state: SimState = { chainage: 0, speed, brakeActual: 1, time: 0 };
  // A standing or moving tick with no DSD ping; ack handled by the caller's intent.
  return tickSafety(base, noIntent(), state, 1 / 60, { reasons });
}

/** Drive `awsFor` to a braked (AWS-latched) AwsState and return it. */
function drivenToBrake(route: Route): AwsState {
  const segs: Seg[] = [crossS1Magnet(8)];
  for (let k = 0; k < 8; k++) segs.push(leg(1_443 + k, 1_444 + k, 8)); // > 3 s @ dt 0.5
  const out = awsFor(route, segs, { dt: 0.5 });
  expect(out.aws.brakeReason).toBe("AWS");
  return out.aws;
}

describe("oracle C2: ack-at-stand clears the reason the SAME tick (no lag)", () => {
  it("braked AWS; ack at a stand ⇒ tickAws returns [], the latch releases this tick", () => {
    const route = aspectRoute();
    const braked = drivenToBrake(route);
    // The ack-at-stand release tick: |speed| ≤ STAND_EPS and acknowledge.
    const restState: SimState = { chainage: 1_452, speed: 0, brakeActual: 1, time: 0 };
    const o = tickAws(braked, restState, route, intent({ acknowledge: true }), 1_452, 1, 0.5);
    expect(o.next.brakeReason).toBeNull();
    expect(o.reasons).toEqual([]); // returns [] the SAME tick

    // Through the DSD-scoped seed (:258) → fold (:275): the set empties at once.
    const safety = tickSafety(
      createInitialSafety(),
      intent({ acknowledge: true }),
      restState,
      0.5,
      { reasons: o.reasons },
    );
    expect(safety.penaltyReasons.has("AWS")).toBe(false);
  });
});

describe("oracle C2-PIN: the DSD-scoped seed is load-bearing", () => {
  it("after the release tick, further [] ticks keep AWS OUT of the latch", () => {
    const route = aspectRoute();
    const braked = drivenToBrake(route);
    const restState: SimState = { chainage: 1_452, speed: 0, brakeActual: 1, time: 0 };

    // The realistic prior-frame latch: AWS already latched (as the previous
    // braked frame left it). This is what makes the seed scoping load-bearing —
    // under the un-scoped seed `new Set(s.penaltyReasons)` AWS would be carried
    // forward forever even after `tickAws` stops demanding it.
    const priorAws: SafetyState = {
      vigilanceTimer: 0,
      dsdWarning: false,
      penaltyReasons: new Set(["AWS"]),
    };

    // Release tick: ack-at-stand ⇒ tickAws returns [], and the DSD-scoped seed
    // does NOT re-carry the prior AWS ⇒ the latch empties this same tick.
    const rel = tickAws(braked, restState, route, intent({ acknowledge: true }), 1_452, 1, 0.5);
    expect(rel.reasons).toEqual([]);
    let safety = tickSafety(priorAws, intent({ acknowledge: true }), restState, 0.5, {
      reasons: rel.reasons,
    });
    expect(safety.penaltyReasons.has("AWS")).toBe(false); // FAILS under an un-scoped seed

    // Subsequent ticks: tickAws keeps returning [] (brakeReason cleared). Under
    // the DSD-scoped seed the latch STAYS empty.
    let aws = rel.next;
    for (let k = 0; k < 5; k++) {
      const o = tickAws(aws, restState, route, noIntent(), 1_452, 1, 0.5);
      aws = o.next;
      safety = tickSafety(safety, noIntent(), restState, 0.5, { reasons: o.reasons });
      expect(safety.penaltyReasons.has("AWS")).toBe(false);
    }
  });
});

describe("oracle C4: ack-WHILE-MOVING never clears the brake (survives)", () => {
  it("braked AWS; ack at speed ⇒ tickAws re-asserts AWS, the latch stays latched", () => {
    const route = aspectRoute();
    let aws = drivenToBrake(route);
    let safety = createInitialSafety();
    // Several moving ack ticks: each re-asserts AWS, the fold re-adds it.
    for (let k = 0; k < 5; k++) {
      const movingState: SimState = { chainage: 1_452 + k, speed: 8, brakeActual: 1, time: 0 };
      const o = tickAws(aws, movingState, route, intent({ acknowledge: true }), 1_452 + k, 1, 0.5);
      aws = o.next;
      expect(o.next.brakeReason).toBe("AWS");
      expect(o.reasons).toEqual(["AWS"]);
      safety = tickSafety(safety, intent({ acknowledge: true }), movingState, 0.5, {
        reasons: o.reasons,
      });
      expect(safety.penaltyReasons.has("AWS")).toBe(true);
    }
  });
});

describe("oracle C-COEXIST: DSD + AWS clear together under one ack-at-stand", () => {
  it("both latched ⇒ a single ack-at-stand empties the latch (one acknowledgment)", () => {
    const route = aspectRoute();
    const braked = drivenToBrake(route);
    const restState: SimState = { chainage: 1_452, speed: 0, brakeActual: 1, time: 0 };
    // A prior latch carrying DSD as well.
    const priorWithDsd: SafetyState = {
      vigilanceTimer: 0,
      dsdWarning: true,
      penaltyReasons: new Set(["DSD", "AWS"]),
    };
    // The ack-at-stand tick: tickAws clears AWS (returns []), the release machine
    // deletes DSD, the DSD-scoped seed carries nothing else ⇒ both gone.
    const o = tickAws(braked, restState, route, intent({ acknowledge: true }), 1_452, 1, 0.5);
    expect(o.reasons).toEqual([]);
    const safety = tickSafety(priorWithDsd, intent({ acknowledge: true }), restState, 0.5, {
      reasons: o.reasons,
    });
    expect(safety.penaltyReasons.size).toBe(0);
  });
});

// ── E — TPWS OSS overspeed (loop = post − 50; trip at OSS_TRIP_SPEED) ─────────

/** A leg whose front sweeps the S1 OSS loop (1570) at `speed`, without crossing
 *  the post (1620) — front 1569 → 1571. */
function crossS1Oss(speed: number): Seg {
  return { prev: S1_OSS - FRONT - 1, now: S1_OSS - FRONT + 1, speed }; // front 1569→1571
}

describe("oracle E1: OSS overspeed behind a RED starter ⇒ TPWS", () => {
  it("cross the OSS loop above the trip speed with the starter RED ⇒ TPWS", () => {
    const route = aspectRoute(); // Riverside unserved ⇒ S1 RED
    const out = awsFor(route, [crossS1Oss(15)], { dt: 0.05 }); // 15 > 13.4
    expect(out.aws.brakeReason).toBe("TPWS");
    expect(out.reasons).toContain("TPWS");
    expect(15).toBeGreaterThan(OSS_TRIP_SPEED);
  });
});

describe("oracle E2: a PSR-compliant approach never trips OSS", () => {
  it("cross the OSS loop below the trip speed ⇒ no TPWS", () => {
    const route = aspectRoute();
    const out = awsFor(route, [crossS1Oss(10)], { dt: 0.05 }); // 10 < 13.4
    expect(out.aws.brakeReason).toBeNull();
    expect(out.reasons).toEqual([]);
    expect(10).toBeLessThan(OSS_TRIP_SPEED);
  });
});

describe("oracle E3: OSS arms only behind a RED starter (non-RED ⇒ no trip)", () => {
  it("served starter (non-RED) ⇒ no OSS trip even at high speed (all three)", () => {
    const route = aspectRoute();
    // Serving only the protected station clears its own held-RED. For S1/S2 a
    // later stop ahead is still unserved (aspect YELLOW); for S3 nothing is ahead
    // (GREEN). Either way the crossing is NON-RED, so OSS stays disarmed — the
    // predicate keys off RED, not specifically GREEN.
    const cases = [
      { station: "Riverside", post: 1_620 },
      { station: "City Centre", post: 3_220 },
      { station: "Victoria Street", post: 4_520 },
    ];
    for (const c of cases) {
      const loop = c.post - OSS_LOOP_OFFSET;
      const seg: Seg = { prev: loop - FRONT - 1, now: loop - FRONT + 1, speed: 20 };
      const out = awsFor(route, [seg], { dt: 0.05, seed: { ...createInitialAws(), served: new Set([c.station]) } });
      expect(out.aws.brakeReason).toBeNull(); // non-RED starter ⇒ OSS disarmed
    }
  });

  it("a genuinely GREEN starter (whole line served) ⇒ no OSS trip", () => {
    const route = aspectRoute();
    // S1 is GREEN only when its station AND everything ahead are served.
    const loop = S1_POST - OSS_LOOP_OFFSET;
    const seg: Seg = { prev: loop - FRONT - 1, now: loop - FRONT + 1, speed: 20 };
    const out = awsFor(route, [seg], { dt: 0.05, seed: { ...createInitialAws(), served: ALL_SERVED } });
    expect(aspectAt(route, 0, ALL_SERVED)).toBe("GREEN"); // genuinely GREEN
    expect(out.aws.brakeReason).toBeNull();
  });
});

// ── F — SPAD ─────────────────────────────────────────────────────────────────

describe("oracle F1-O: forward crossing a RED starter sets spad; GREEN does not", () => {
  it("RED post crossing ⇒ hud.spad true; served (GREEN) post crossing ⇒ false", () => {
    const route = aspectRoute();
    // RED: Riverside unserved.
    const red = awsFor(route, [{ prev: S1_POST - FRONT - 1, now: S1_POST - FRONT + 1, speed: 8 }], {
      dt: 0.05,
    });
    expect(red.hud.spad).toBe(true);
    // GREEN: serve Riverside first (seed served), then cross the post.
    const green = awsFor(route, [{ prev: S1_POST - FRONT - 1, now: S1_POST - FRONT + 1, speed: 8 }], {
      dt: 0.05,
      seed: { ...createInitialAws(), served: new Set(["Riverside"]) },
    });
    expect(green.hud.spad).toBe(false);
    expect(green.aws.brakeReason).toBeNull();
  });
});

describe("oracle F-keystone (machine): a served stop then depart is SPAD-free end-to-end", () => {
  it("stand to serve S1 ⇒ GREEN; depart sweeping the now-GREEN post ⇒ brakeReason null, hud.spad false", () => {
    const route = aspectRoute();
    // The machine-level keystone: a stand within Riverside's platform serves the
    // station (S1 GREEN over the served-set's whole forward cascade needs the line
    // ahead too, but the POST predicate keys off RED only). Serving clears S1's
    // held-RED, so the forward leg that sweeps the post crosses a NON-RED signal.
    const segs: Seg[] = [
      stand(1_498), // front 1500 == board ⇒ serves Riverside, S1 no longer RED
      { prev: S1_POST - FRONT - 5, now: S1_POST + FRONT + 5, speed: 8 }, // sweep the post
    ];
    const out = awsFor(route, segs, { dt: 0.05 });
    expect(out.aws.served.has("Riverside")).toBe(true);
    expect(out.aws.brakeReason).toBeNull(); // no SPAD/TPWS latch
    expect(out.hud.spad).toBe(false); // the SPAD-free keystone, end-to-end
    expect(out.reasons).toEqual([]);
  });

  it("whole-line-served drive ⇒ GREEN post, no brake, no spad", () => {
    const route = aspectRoute();
    // With ALL_SERVED the post is genuinely GREEN; sweep it ⇒ still SPAD-free.
    const out = awsFor(route, [{ prev: S1_POST - FRONT - 5, now: S1_POST + FRONT + 5, speed: 8 }], {
      dt: 0.05,
      seed: { ...createInitialAws(), served: ALL_SERVED },
    });
    expect(aspectAt(route, 0, ALL_SERVED)).toBe("GREEN");
    expect(out.aws.brakeReason).toBeNull();
    expect(out.hud.spad).toBe(false);
    expect(out.reasons).toEqual([]);
  });
});

describe("oracle F2-O: SPAD asserts only TPWS; spad is sticky after release", () => {
  it("the only reason is TPWS, and spad survives an ack-at-stand release", () => {
    const route = aspectRoute();
    const spadded = awsFor(route, [{ prev: S1_POST - FRONT - 1, now: S1_POST - FRONT + 1, speed: 8 }], {
      dt: 0.05,
    });
    expect(spadded.reasons).toEqual(["TPWS"]); // no new union member
    expect(spadded.hud.spad).toBe(true);
    // Ack at a stand releases the brake but `spad` stays sticky.
    const restState: SimState = { chainage: S1_POST + 1, speed: 0, brakeActual: 1, time: 0 };
    const o = tickAws(spadded.aws, restState, route, intent({ acknowledge: true }), S1_POST + 1, 1, 0.05);
    expect(o.next.brakeReason).toBeNull();
    expect(o.next.spad).toBe(true); // sticky scored event
    expect(o.hud.spad).toBe(true);
  });
});

describe("oracle D1 (machine): TSS on an unserved red sets the full latch", () => {
  it("front crosses S1 RED ⇒ TPWS, brakeReason TPWS, hud.spad true", () => {
    const route = aspectRoute();
    const out = awsFor(route, [{ prev: S1_POST - FRONT - 1, now: S1_POST - FRONT + 1, speed: 8 }], {
      dt: 0.05,
    });
    expect(out.aws.brakeReason).toBe("TPWS");
    expect(out.reasons).toContain("TPWS");
    expect(out.hud.spad).toBe(true);
  });

  it("D2 (reverse): the same geometry reversing crosses nothing ⇒ no TPWS/spad", () => {
    const route = aspectRoute();
    // Reverse: front sweeps backward across the post (frontNow < frontPrev).
    const out = awsFor(route, [{ prev: S1_POST + 5, now: S1_POST - 5, speed: -8 }], {
      dt: 0.05,
      dir: -1,
    });
    expect(out.aws.brakeReason).toBeNull();
    expect(out.hud.spad).toBe(false);
  });
});

// ── G — determinism / dt-slice independence (STEADY intervals only) ──────────

describe("oracle G1: STEADY mid-countdown WARNING is dt-slice independent", () => {
  it("coarse vs fine slices of a steady span reach equal warnTimer/phase/etc.", () => {
    const route = aspectRoute(); // held-RED, never-served starter throughout
    // A steady span: no magnet crossing, no serve, WARNING already running with
    // warnTimer partially elapsed; the span never drives warnTimer to 0.
    const seed: AwsState = {
      phase: "WARNING",
      warnTimer: 2.0,
      sunflower: "CAUTION",
      brakeReason: null,
      served: new Set(),
      spad: false,
    };
    // Positions stay between the magnet (1440) and the OSS loop (1570) — no
    // crossing of any feature within the span (front 1500 → 1505).
    const span = { prevC: 1_498, nowC: 1_503, speed: 8 }; // front 1500 → 1505
    const total = 1.0; // s; 2.0 − 1.0 = 1.0 > 0 ⇒ stays in WARNING

    // Coarse: one tick over the whole span.
    const coarse = awsFor(route, [{ prev: span.prevC, now: span.nowC, speed: span.speed }], {
      dt: total,
      seed,
    });
    // Fine: 10 sub-steps splitting the same span and the same total dt.
    const n = 10;
    const segs: Seg[] = [];
    for (let k = 0; k < n; k++) {
      const p = span.prevC + (span.nowC - span.prevC) * (k / n);
      const q = span.prevC + (span.nowC - span.prevC) * ((k + 1) / n);
      segs.push({ prev: p, now: q, speed: span.speed });
    }
    const fine = awsFor(route, segs, { dt: total / n, seed });

    expect(coarse.aws.warnTimer).toBeCloseTo(fine.aws.warnTimer, 9);
    expect(coarse.aws.phase).toBe(fine.aws.phase);
    expect(coarse.aws.phase).toBe("WARNING"); // non-vacuous: still counting down
    expect(coarse.aws.sunflower).toBe(fine.aws.sunflower);
    expect(coarse.aws.brakeReason).toBe(fine.aws.brakeReason);
    expect([...coarse.reasons].sort()).toEqual([...fine.reasons].sort());
    // Non-vacuous: warnTimer actually decremented by the full span dt.
    expect(coarse.aws.warnTimer).toBeCloseTo(2.0 - total, 9);
  });
});

describe("oracle G2: within-tick AWS-vs-TPWS precedence (coarse AND fine arms)", () => {
  it("coarse: a single dt past magnet AND red post ⇒ TPWS + spad", () => {
    const route = aspectRoute(); // S1 RED (never served)
    // One coarse leg whose front sweeps from before the magnet (1440) to past the
    // post (1620): front 1430 → 1630.
    const out = awsFor(route, [{ prev: 1_428, now: 1_628, speed: 8 }], { dt: 0.5 });
    expect(out.aws.brakeReason).toBe("TPWS"); // TSS overwrites the AWS warning
    expect(out.hud.spad).toBe(true);
  });

  it("fine: cross the magnet, then the post, in two sub-steps ⇒ same end-state", () => {
    const route = aspectRoute();
    // Sub-step 1: front 1430 → 1500 (crosses magnet 1440 only).
    // Sub-step 2: front 1500 → 1630 (crosses post 1620).
    const out = awsFor(
      route,
      [
        { prev: 1_428, now: 1_498, speed: 8 },
        { prev: 1_498, now: 1_628, speed: 8 },
      ],
      { dt: 0.25 },
    );
    expect(out.aws.brakeReason).toBe("TPWS");
    expect(out.hud.spad).toBe(true);
    expect([...out.reasons].sort()).toEqual(["TPWS"]);
  });
});

describe("oracle G2-clobber: a latched TPWS is never relabelled AWS by a stale WARNING", () => {
  it("braked (TPWS, spad) with a WARNING still in flight ⇒ brakeReason STAYS TPWS past warnTimer→0", () => {
    const route = aspectRoute(); // S1 RED (never served)
    // Reach a state with BOTH: brakeReason="TPWS"/spad (front swept the RED post)
    // AND an outstanding WARNING (warnTimer>0). The single coarse leg sweeps from
    // before the magnet (1440) past the post (1620): the magnet arms the WARNING
    // (warnTimer = AWS_WARN_WINDOW = 3) and the post then latches TPWS. With the
    // F1 guard, the WARNING countdown is frozen while braked, so warnTimer stays
    // at 3 and never drives brakeReason to "AWS".
    const seed = awsFor(route, [{ prev: 1_428, now: 1_628, speed: 8 }], { dt: 0.5 }).aws;
    expect(seed.brakeReason).toBe("TPWS");
    expect(seed.spad).toBe(true);
    expect(seed.phase).toBe("WARNING"); // warning still in flight
    expect(seed.warnTimer).toBeGreaterThan(0);

    // Tick forward several times with NO ack, well past where warnTimer would hit
    // 0 (a frozen 3 s window over 6 × 1 s steps), keeping the front past the post
    // so nothing new fires. brakeReason must stay "TPWS" (never flip to "AWS").
    let aws = seed;
    let lastReasons: PenaltyReason[] = [];
    for (let k = 0; k < 6; k++) {
      const o = tickAws(
        aws,
        { chainage: 1_630 + k, speed: 8, brakeActual: 1, time: 0 },
        route,
        noIntent(),
        1_629 + k,
        1,
        1.0,
      );
      aws = o.next;
      lastReasons = o.reasons;
      expect(aws.brakeReason).toBe("TPWS"); // NEVER relabelled "AWS"
      expect(aws.spad).toBe(true); // SPAD stays
    }
    expect(lastReasons).toEqual(["TPWS"]);
  });
});

describe("oracle G-NOTE: served-changing / warning-starting intervals are EXCLUDED", () => {
  it("documents (and exercises) why those intervals are out of the dt-slice claim", () => {
    // The dt-slice-independence claim (G1/G2) holds ONLY for STEADY intervals:
    // those in which `served` does not change and no WARNING starts. Two writes
    // are dt-sensitive and so are excluded by construction:
    //  (1) the served-set sample — the exact tick a station flips to served
    //      depends on slicing (served is updated BEFORE the swept crossings);
    //  (2) the warn-countdown phase — warnTimer's offset shifts by ≤ one slice
    //      depending on which sub-step the magnet falls in.
    // Both are safe in practice: the runtime clamps dt to MAX_DT = 0.05, so a real
    // frame never spans both a magnet and a serve, nor a magnet and its post
    // (separations ≥ 20 m, far above one clamped frame's travel). No event-time
    // interpolation (over-engineering for this scope).
    // A concrete witness that a WARNING-STARTING interval is dt-sensitive: a
    // coarse tick that both starts the warning AND counts it down differs from a
    // fine slicing that starts it later. (Excluded — not a steady interval.)
    const route = aspectRoute();
    const coarse = awsFor(route, [crossS1Magnet(8)], { dt: 1.0 });
    const fineThenStart = awsFor(
      route,
      [
        leg(1_430, 1_432, 8), // no crossing yet
        crossS1Magnet(8), // warning starts only here
      ],
      { dt: 0.5 },
    );
    // Different warnTimer ⇒ this interval is NOT dt-slice independent (excluded).
    expect(coarse.aws.warnTimer).not.toBeCloseTo(fineThenStart.aws.warnTimer, 6);
  });
});

// ── H — O13 migration: signal-free route ⇒ no reasons ────────────────────────

describe("oracle H1: signal-free route ⇒ tickAws returns no reasons", () => {
  it("moving and standing states on signals:[] never produce a reason", () => {
    const route = emptyRoute();
    const moving: SimState = { chainage: 100, speed: 20, brakeActual: 1, time: 0 };
    const standing: SimState = { chainage: 0, speed: 0, brakeActual: 1, time: 0 };
    expect(tickAws(createInitialAws(), moving, route, noIntent(), 80, 1, 1 / 60).reasons).toEqual([]);
    expect(tickAws(createInitialAws(), standing, route, noIntent(), 0, 1, 1 / 60).reasons).toEqual([]);
  });
});

// ── G3 — determinism grep guard (no wall-clock under src/sim) ─────────────────

describe("oracle G3: no Date/Math.random/performance.now/setTimeout under src/sim", () => {
  it("the sim core is free of wall-clock / nondeterministic tokens", () => {
    // Read every src/sim/*.ts source as raw text. `import.meta.glob` is a Vite
    // transform that is statically replaced, so it MUST be referenced by its full
    // literal name (no aliasing). The tsconfig omits the Vite client types, so the
    // expression is cast.
    const sources = (
      import.meta as unknown as {
        glob: (
          pattern: string,
          opts: { query: string; import: string; eager: boolean },
        ) => Record<string, string>;
      }
    ).glob("../src/sim/*.ts", { query: "?raw", import: "default", eager: true });
    const banned = /Date|Math\.random|performance\.now|setTimeout|setInterval/;
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(0); // non-vacuous: it actually read files
    for (const [path, src] of Object.entries(sources)) {
      expect(banned.test(src), `${path} contains a banned token`).toBe(false);
    }
  });
});
