import type { TrainSpec } from "./physics";
import { acceleration, approach, clamp, clamp01 } from "./physics";
import type { Route } from "./route";
import { gradeAt, speedLimitAt } from "./route";
import { BRAKE_LAG } from "./train";

/** Driver/environment inputs for one tick. */
export interface SimInputs {
  /** Power notch demand, 0–1. */
  notch: number;
  /** Brake demand, 0–1. */
  brake: number;
  /** Reverser, +1 (toward Eastbank) or -1. */
  dir: 1 | -1;
  /** Rail adhesion coefficient. */
  mu: number;
}

/** Everything the world needs to render one frame. */
export interface SimState {
  /** Chainage along the route, m. */
  chainage: number;
  /** Velocity, m/s (signed). */
  speed: number;
  /** Actual brake fraction after build-up/release lag, 0–1. */
  brakeActual: number;
  /** Elapsed sim time, s. */
  time: number;
}

export function createInitialState(chainage = 0): SimState {
  return { chainage, speed: 0, brakeActual: 1, time: 0 };
}

const MAX_DT = 0.05; // clamp long frames
const SUBSTEP = 1 / 240; // fixed-timestep integration for stability/determinism

/**
 * Advance the simulation by `dt` seconds. Pure: returns a new state, mutates
 * nothing. Integrates with a fixed sub-step so behaviour is frame-rate
 * independent and deterministic.
 */
export function step(
  spec: TrainSpec,
  route: Route,
  state: SimState,
  inputs: SimInputs,
  dt: number,
): SimState {
  let { chainage, speed, brakeActual, time } = state;
  let remaining = Math.min(Math.max(dt, 0), MAX_DT);
  const notch = clamp01(inputs.notch);
  const brakeDemand = clamp01(inputs.brake);

  while (remaining > 1e-9) {
    const h = Math.min(SUBSTEP, remaining);
    remaining -= h;

    const tau = brakeDemand > brakeActual ? BRAKE_LAG.buildTau : BRAKE_LAG.releaseTau;
    brakeActual = approach(brakeActual, brakeDemand, tau, h);

    const grade = gradeAt(route, chainage);
    const a = acceleration(spec, {
      v: speed,
      notch,
      brakeActual,
      dir: inputs.dir,
      grade,
      mu: inputs.mu,
    });

    const prevSpeed = speed;
    speed += a * h; // semi-implicit: use updated speed for position

    // Snap to a true standstill when coasting/braking brings us through zero
    // with no net drive, so the train doesn't jitter or creep around 0.
    if (prevSpeed !== 0 && Math.sign(speed) !== Math.sign(prevSpeed) && notch === 0) {
      speed = 0;
    }

    chainage += speed * h;
    if (chainage <= 0 && speed < 0) {
      chainage = 0;
      speed = 0;
    } else if (chainage >= route.length && speed > 0) {
      chainage = route.length;
      speed = 0;
    }
    time += h;
  }

  return { chainage, speed, brakeActual, time };
}

/** Convenience: posted limit at the train's current chainage, m/s. */
export function currentSpeedLimit(route: Route, state: SimState): number {
  return clamp(speedLimitAt(route, state.chainage), 0, Infinity);
}
