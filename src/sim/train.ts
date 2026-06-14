import type { TrainSpec } from "./physics";

// A ~4-car GTO-inverter EMU in the spirit of a Class 365 — the unit whose
// rising "gearbox" whine we want to synthesise. Numbers are representative and
// will be tuned against references in a later phase; they live here so the
// whole sim reads from one place.
export const EMU_GTO_4CAR: TrainSpec = {
  mass: 160_000, // kg, loaded
  inertiaFactor: 1.08,
  powerMax: 1_000_000, // W (~1 MW at rail)
  tractiveEffortMax: 120_000, // N
  speedMax: 44.7, // m/s (~100 mph)
  davisA: 3_000,
  davisB: 120,
  davisC: 7,
  adhesiveFraction: 0.5, // half the axles motored
  brakeServiceDecel: 0.9, // m/s² full service
  brakeEmergencyDecel: 1.3, // m/s²
};

/** Rail adhesion by condition — wet night is the signature setting. */
export const ADHESION = {
  dry: 0.3,
  wetNight: 0.2,
} as const;

/** Brake first-order time constants, seconds. */
export const BRAKE_LAG = {
  buildTau: 1.5,
  releaseTau: 2.0,
} as const;
