// Longitudinal point-mass train dynamics. Pure functions, no rendering, no
// global state — everything the tests need to pin "what correct looks like".
//
// Sign convention: a single scalar `chainage` (metres) runs along the route.
// `v > 0` moves toward increasing chainage. `grade` is rise/run in the
// increasing-chainage direction (positive = uphill that way). `dir` is the
// reverser: +1 drives toward increasing chainage, -1 toward decreasing.

export const G = 9.80665; // m/s²

export interface TrainSpec {
  /** Tare+load mass, kg. */
  mass: number;
  /** Rotational-inertia factor (effective mass = mass * this). ~1.05–1.10. */
  inertiaFactor: number;
  /** Continuous power at rail, W. */
  powerMax: number;
  /** Maximum tractive effort at low speed, N (before adhesion limit). */
  tractiveEffortMax: number;
  /** Design top speed, m/s. */
  speedMax: number;
  /** Davis resistance R(v)=A+B·v+C·v², SI units (N, N·s/m, N·s²/m²). */
  davisA: number;
  davisB: number;
  davisC: number;
  /** Fraction of mass carried on driven (adhesive) axles, 0–1. */
  adhesiveFraction: number;
  /** Full-service brake deceleration target, m/s² (before adhesion limit). */
  brakeServiceDecel: number;
  /** Emergency brake deceleration target, m/s². */
  brakeEmergencyDecel: number;
}

/** Effective (incl. rotational) mass, kg. */
export function effectiveMass(spec: TrainSpec): number {
  return spec.mass * spec.inertiaFactor;
}

/**
 * Maximum tractive effort available at a given speed (N, ≥ 0), before the
 * driver's power notch is applied. Flat at `tractiveEffortMax` up to the base
 * speed, then constant-power (P/v), and capped by available adhesion.
 */
export function tractiveEffort(spec: TrainSpec, speed: number, mu: number): number {
  const v = Math.max(Math.abs(speed), 1e-3);
  const constantPower = spec.powerMax / v;
  const available = Math.min(spec.tractiveEffortMax, constantPower);
  const adhesionLimit = mu * spec.adhesiveFraction * spec.mass * G;
  return Math.max(0, Math.min(available, adhesionLimit));
}

/** Davis running resistance magnitude (N, ≥ 0) — always opposes motion. */
export function davisResistance(spec: TrainSpec, speed: number): number {
  const v = Math.abs(speed);
  return Math.max(0, spec.davisA + spec.davisB * v + spec.davisC * v * v);
}

/** Brake force for a given actual brake fraction (N, ≥ 0), adhesion-limited. */
export function brakeForce(spec: TrainSpec, brakeActual: number, mu: number): number {
  const demanded = clamp01(brakeActual) * spec.brakeServiceDecel * effectiveMass(spec);
  const adhesionLimit = mu * spec.mass * G; // braked on all axles
  return Math.max(0, Math.min(demanded, adhesionLimit));
}

export interface AccelInputs {
  /** Current velocity, m/s (signed). */
  v: number;
  /** Power notch, 0–1. */
  notch: number;
  /** Actual (post-lag) brake fraction, 0–1. */
  brakeActual: number;
  /** Reverser: +1 or -1. */
  dir: 1 | -1;
  /** Grade (rise/run) in the increasing-chainage direction. */
  grade: number;
  /** Rail adhesion coefficient (dry ≈ 0.30, wet night ≈ 0.20). */
  mu: number;
}

/**
 * Instantaneous longitudinal acceleration (m/s²). Handles the static case at
 * a standstill so a braked train never creeps, and so it only rolls away when
 * gravity/traction actually overcome the brake.
 */
export function acceleration(spec: TrainSpec, inp: AccelInputs): number {
  const meff = effectiveMass(spec);
  const fTraction = inp.notch * tractiveEffort(spec, inp.v, inp.mu) * inp.dir;
  const fGravity = -spec.mass * G * inp.grade; // along +chainage
  const fBrake = brakeForce(spec, inp.brakeActual, inp.mu);
  const fResist = davisResistance(spec, inp.v);

  const vEps = 1e-3;
  if (Math.abs(inp.v) > vEps) {
    const opposing = Math.sign(inp.v) * (fResist + fBrake);
    return (fTraction + fGravity - opposing) / meff;
  }
  // Near standstill: brake + static effects can hold the train.
  const fDrive = fTraction + fGravity;
  if (Math.abs(fDrive) <= fBrake) return 0; // held
  return (fDrive - Math.sign(fDrive) * fBrake) / meff;
}

/** First-order lag toward a target (brake build-up / release dynamics). */
export function approach(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
