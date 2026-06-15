// Pure environment model for the world: time-of-day × weather → physics (μ)
// plus visual params (sky/fog, lights, rain, rail wetness, wiper). HLD §2.1.
//
// This is the one load-bearing testable seam of Phase 4: weather drives μ,
// which feeds the *real* longitudinal physics in physics.ts via resolveInputs.
// Pure math/mapping only: no Three.js, no DOM, no wall-clock, no randomness.

export type TimeOfDay = "day" | "dusk" | "night";
export type Weather = "clear" | "rain" | "storm";

export interface Environment {
  time: TimeOfDay;
  weather: Weather;
}

export interface EnvironmentParams {
  // physics
  /** Rail adhesion → resolveInputs (feeds real traction/brake caps). */
  mu: number;
  // visuals (consumed by scene.ts; all plain numbers/hex so they stay testable)
  /** hex; also the fog colour. */
  skyColor: number;
  fogNear: number;
  fogFar: number;
  /** hemisphere light. */
  ambientIntensity: number;
  /** directional ("moon"/"sun") light. */
  moonIntensity: number;
  /** 0..1 → particle opacity (& count scale); 0 ⇒ no rain. */
  rainIntensity: number;
  /** 0..1 → rail roughness (wet = lower roughness/sheen). */
  railWetness: number;
  /** wiper sweeps iff it's raining. */
  wiperOn: boolean;
}

/** The signature setting and the ring's first entry. */
export const DEFAULT_ENVIRONMENT: Environment = { time: "night", weather: "rain" };

/**
 * The preset ring the demo key cycles. Signature wet-night first, then a clear
 * night, a wet dusk, and a clear day — back to the head. Used by
 * `cycleEnvironment`; ENV6 walks it back to `DEFAULT_ENVIRONMENT`.
 */
export const PRESET_RING: Environment[] = [
  { time: "night", weather: "rain" }, // signature wet-night (== DEFAULT_ENVIRONMENT)
  { time: "night", weather: "clear" },
  { time: "dusk", weather: "rain" },
  { time: "day", weather: "clear" },
];

/** Adhesion floor — μ never drops below this however greasy the rail. */
const MU_FLOOR = 0.15;

/** Base adhesion per weather (clear == ADHESION.dry). */
const weatherBase: Record<Weather, number> = {
  clear: 0.3,
  rain: 0.25,
  storm: 0.2,
};

/** Time-of-day multiplier (cooler/greasier rail later in the day). */
const timeFactor: Record<TimeOfDay, number> = {
  day: 1.0,
  dusk: 0.9,
  night: 0.8,
};

/** Rain particle intensity per weather (0 ⇒ dry). */
const rainByWeather: Record<Weather, number> = {
  clear: 0,
  rain: 0.6,
  storm: 1.0,
};

/** Rail wetness per weather (slight residual damp even when "clear"). */
const wetnessByWeather: Record<Weather, number> = {
  clear: 0.1,
  rain: 0.8,
  storm: 1.0,
};

/** Brightness multiplier per time of day — strictly increasing night→day. */
const brightness: Record<TimeOfDay, number> = {
  night: 0.5,
  dusk: 0.7,
  day: 1.0,
};

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * Map an environment to physics + visual parameters (HLD §2.1).
 *
 * - μ = clamp(weatherBase[weather] × timeFactor[time], ≥ 0.15). The exact round
 *   numbers pin night×rain = 0.25 × 0.8 = 0.20 == ADHESION.wetNight (ENV4), so
 *   the default leaves physics bit-identical.
 * - Lighting brightens strictly night → dusk → day for a fixed weather (ENV2);
 *   `night` is deep blue and dark, `day` brightest.
 * - `rainIntensity`/`wiperOn` are nonzero/true iff it's not clear (ENV3); both
 *   `rainIntensity` and `railWetness` stay in [0, 1] (ENV5).
 */
export function environmentParams(env: Environment): EnvironmentParams {
  const mu = clamp(weatherBase[env.weather] * timeFactor[env.time], MU_FLOOR, 1);

  const rainIntensity = rainByWeather[env.weather];
  const railWetness = wetnessByWeather[env.weather];
  const wiperOn = env.weather !== "clear";
  const b = brightness[env.time];

  // Storminess darkens and tightens fog; clear is clearest. 0 (clear) .. 1 (storm).
  const storminess = rainIntensity;

  // Lighting: scale base levels by time-of-day brightness so both ambient and
  // moon strictly increase night<dusk<day (ENV2). Cloud/storm dims a little.
  // Ceilings are tuned so "day" genuinely lights surfaces (not just a bright sky)
  // while night stays moody — the lit platform lamps carry the night stations.
  const cloudDim = 1 - 0.25 * storminess;
  const ambientIntensity = 0.85 * b * cloudDim;
  const moonIntensity = 1.2 * b * cloudDim;

  // Sky/fog colour: deep blue at night, lighter toward day; greyer (less blue)
  // and tighter range when stormy. Encoded as a single hex RGB.
  const skyColor = skyColorFor(env.time, storminess);

  // Fog: tighter (nearer far plane) at night and in storm; open in clear day.
  const fogNear = 12 + 8 * b; // 12 (night) .. 20 (day)
  const fogFar = 60 + 140 * b - 40 * storminess; // deep day-clear, tight storm-night

  return {
    mu,
    skyColor,
    fogNear,
    fogFar,
    ambientIntensity,
    moonIntensity,
    rainIntensity,
    railWetness,
    wiperOn,
  };
}

/** Deep-blue night → light overcast day, greyed by storminess. Returns hex RGB. */
function skyColorFor(time: TimeOfDay, storminess: number): number {
  // Base sky per time (deep blue night, warm-grey dusk, pale day).
  const base: Record<TimeOfDay, { r: number; g: number; b: number }> = {
    night: { r: 0x0a, g: 0x12, b: 0x28 }, // deep blue
    dusk: { r: 0x3a, g: 0x30, b: 0x40 }, // dim warm-violet
    day: { r: 0x9a, g: 0xa8, b: 0xc0 }, // pale overcast
  };
  const c = base[time];
  // Storm pulls toward a darker neutral grey (deeper, less saturated).
  const grey = 0x20;
  const t = 0.4 * storminess;
  const r = Math.round(c.r * (1 - t) + grey * t);
  const g = Math.round(c.g * (1 - t) + grey * t);
  const bl = Math.round(c.b * (1 - t) + grey * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Step the preset ring: return the entry after `env` (matched by value), or the
 * ring head if `env` is not in the ring. Walking the ring `PRESET_RING.length`
 * times from `DEFAULT_ENVIRONMENT` returns to `DEFAULT_ENVIRONMENT` (ENV6).
 */
export function cycleEnvironment(env: Environment): Environment {
  const i = PRESET_RING.findIndex(
    (e) => e.time === env.time && e.weather === env.weather,
  );
  if (i < 0) {
    const head = PRESET_RING[0];
    // PRESET_RING is a non-empty literal; head is always defined.
    return head ?? DEFAULT_ENVIRONMENT;
  }
  const next = PRESET_RING[(i + 1) % PRESET_RING.length];
  return next ?? DEFAULT_ENVIRONMENT;
}
