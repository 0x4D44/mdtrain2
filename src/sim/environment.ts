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
  /** hex — the zenith sky colour. */
  skyColor: number;
  /** hex — the (paler/warmer by day) horizon-band colour, distinct from the zenith
   *  `skyColor`; also the fog/haze colour so distance washes into the horizon. */
  horizonColor: number;
  fogNear: number;
  fogFar: number;
  /** hemisphere light intensity. */
  ambientIntensity: number;
  /** directional sun/moon light intensity. */
  moonIntensity: number;
  /** hex — hemisphere sky colour (warm/bright by day, cool/dim by night). */
  hemiSky: number;
  /** hex — hemisphere ground bounce colour. */
  hemiGround: number;
  /** hex — directional sun/moon colour. */
  sunColor: number;
  /** hex — the ground plane's base colour (lit grass/ballast by day). */
  groundColor: number;
  /** 0..1 → particle opacity (& count scale); 0 ⇒ no rain. */
  rainIntensity: number;
  /** 0..1 → rail roughness (wet = lower roughness/sheen). */
  railWetness: number;
  /** wiper sweeps iff it's raining. */
  wiperOn: boolean;
  // realism palette (HLD §2.3) — consumed by scene.ts; pure numbers/hex/unit-vec.
  /** `toneMappingExposure` per time-of-day. Finite > 0; day > dusk > night (O10). */
  exposure: number;
  /** UNIT sun/moon direction per time-of-day (|sunDir| = 1, O11). */
  sunDir: { x: number; y: number; z: number };
  /** hex — linear-ish PBR sun/moon colour per time-of-day. */
  sunColorPbr: number;
  /** per time×weather bloom strength. Finite ≥ 0; night×rain strongest (O10). */
  bloomStrength: number;
  /** 0 (day) … 1 (night): how strongly the celestial layer (moon disc + halo +
   *  stars) reads. Time-only, strictly increasing day < dusk < night (O13). */
  nightFactor: number;
}

/** The default setting and the ring's first entry — a bright, clearly-visible
 *  rainy day (the wet-night that the project is named for stays one cycle away).
 */
export const DEFAULT_ENVIRONMENT: Environment = { time: "day", weather: "rain" };

/**
 * The preset ring the demo/help key cycles. Rainy day first (the visible
 * default), then a rainy sunset, the moody wet-night, and a clear day — back to
 * the head. Used by `cycleEnvironment`; ENV6 walks it back to `DEFAULT_ENVIRONMENT`.
 */
export const PRESET_RING: Environment[] = [
  { time: "day", weather: "rain" }, // rainy day — the visible default (== DEFAULT_ENVIRONMENT)
  { time: "dusk", weather: "rain" }, // rainy sunset
  { time: "night", weather: "rain" }, // the signature wet-night
  { time: "day", weather: "clear" }, // clear day
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

/**
 * Lighting per time of day: hemisphere sky/ground colours, the sun/moon colour,
 * their intensities, and the lit ground colour. Tuned so DAY genuinely lights
 * surfaces (warm, bright, near-neutral) rather than just painting a bright sky,
 * DUSK is warm and golden, and NIGHT stays cool and moody. Intensities strictly
 * increase night < dusk < day (ENV2).
 */
interface Lighting {
  hemiSky: number;
  hemiGround: number;
  sun: number;
  ambI: number;
  sunI: number;
  ground: number;
}
const LIGHTING: Record<TimeOfDay, Lighting> = {
  day: { hemiSky: 0xdfe9f5, hemiGround: 0x8f9470, sun: 0xfff6e6, ambI: 1.5, sunI: 2.1, ground: 0x5e6a44 },
  dusk: { hemiSky: 0xf2b079, hemiGround: 0x4a3742, sun: 0xff9a52, ambI: 1.0, sunI: 1.35, ground: 0x40392e },
  night: { hemiSky: 0x1a2636, hemiGround: 0x03040a, sun: 0x8aa0c8, ambI: 0.6, sunI: 0.6, ground: 0x141b22 },
};

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * `toneMappingExposure` per time-of-day (HLD §2.3). More daylight ⇒ higher
 * exposure: day > dusk > night (O10). All finite > 0.
 */
const EXPOSURE: Record<TimeOfDay, number> = {
  day: 1.0,
  dusk: 0.85,
  night: 0.75, // lifted from 0.65 so the rails/ballast silhouette (not a black void)
};

/**
 * Celestial visibility per time-of-day (HLD §2.D): 0 by day (moon/stars washed
 * out by exposure), a faint hint at dusk, full at night. Time-only (a clear sky
 * vs cloud is a later refinement); strictly increasing day < dusk < night (O13),
 * so it gives scene.ts a single clean scalar to fade the moon/halo/star layer.
 */
const NIGHT_FACTOR: Record<TimeOfDay, number> = {
  day: 0,
  dusk: 0.2,
  night: 1,
};

/**
 * Raw (un-normalised) sun/moon direction per time-of-day. `environmentParams`
 * normalises these so |sunDir| = 1 exactly (O11). High warm sun by day, low
 * golden sun at dusk, a cooler high moon at night — all pointing toward the
 * light source (the convention scene.ts's DirectionalLight expects).
 */
const SUN_DIR_RAW: Record<TimeOfDay, { x: number; y: number; z: number }> = {
  // Day sun GRAZES (lower y) so surfaces show a lit/shadowed side — the strongest
  // outdoor depth cue. Dusk/night left as-is (their shading already reads).
  day: { x: -0.55, y: 0.6, z: 0.32 },
  dusk: { x: -0.8, y: 0.25, z: 0.1 },
  // Match the VISIBLE moon (scene.ts MOON_DIR ≈ (-0.2,0.4,0.9)) so moonlit sheen
  // falls on the moon-facing side — not ~160° away as before (R2).
  night: { x: -0.2, y: 0.4, z: 0.9 },
};

/** Linear-ish PBR sun/moon colour per time: warm-white day, orange dusk, cool moon. */
const SUN_COLOR_PBR: Record<TimeOfDay, number> = {
  day: 0xfff4e0,
  dusk: 0xff9442,
  night: 0x7d92c4,
};

/**
 * Bloom strength factors. `bloomStrength = darkness[time] × wetGlow[weather]`.
 * Darker times bloom more (lamp halos read in the dark), so night > dusk > day
 * for any fixed weather. `wetGlow` peaks at *rain* (not storm): wet streets and
 * lamp halos glow strongest in steady rain, while a storm's heavier downpour
 * slightly veils the lights. Both factors strictly increase toward night×rain,
 * so night×rain is the unique global maximum (O10).
 */
const darknessBloom: Record<TimeOfDay, number> = {
  day: 0.2,
  dusk: 0.5,
  night: 0.65, // was 1.0 — tamed so the moon/lamp keep their cores (no white blobs);
  // still the strongest time (night > dusk > day) so O10 ordering + night×rain-max hold.
};
const wetGlowBloom: Record<Weather, number> = {
  clear: 0.6,
  storm: 0.85,
  rain: 1.0,
};

/** Normalise a raw direction to a unit vector (|v| = 1 within 1e-12). */
function unit(v: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

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

  // Storminess darkens and tightens fog; clear is clearest. 0 (clear) .. 1 (storm).
  const storminess = rainIntensity;

  // Lighting: per-time colour + intensity preset, knocked back a little under
  // cloud/rain. Intensities strictly increase night<dusk<day (ENV2) because the
  // cloud factor depends only on weather, not time.
  const L = LIGHTING[env.time];
  const cloudDim = 1 - 0.3 * storminess;
  const ambientIntensity = L.ambI * cloudDim;
  const moonIntensity = L.sunI * cloudDim;

  // Sky/fog colour: deep blue at night, lighter toward day; greyer (less blue)
  // and tighter range when stormy. Encoded as a single hex RGB.
  const skyColor = skyColorFor(env.time, storminess);
  // The horizon band is distinct from the zenith: pale/luminous by day, warm at
  // dusk, faintly-lit deep blue at night — and it's the fog/haze colour so distant
  // land washes into it (R3 — kills the flat monochrome sky-card + knife horizon).
  const horizonColor = horizonColorFor(env.time, storminess);

  // Fog: open by day, tighter at night and in storm. Pulled in so aerial
  // perspective ALWAYS bites and the far ground hazes before its edge (R5).
  const dayness = env.time === "day" ? 1 : env.time === "dusk" ? 0.6 : 0;
  const fogNear = 14 + 12 * dayness; // 14 (night) .. 26 (day)
  const fogFar = 70 + 90 * dayness - 40 * storminess; // ~160 day clear, 70 night

  // Realism palette (HLD §2.3). exposure & sun colour/dir depend on time only;
  // bloom on time×weather. sunDir is normalised to a unit vector (O11).
  const exposure = EXPOSURE[env.time];
  const sunDir = unit(SUN_DIR_RAW[env.time]);
  const sunColorPbr = SUN_COLOR_PBR[env.time];
  const bloomStrength = darknessBloom[env.time] * wetGlowBloom[env.weather];
  const nightFactor = NIGHT_FACTOR[env.time];

  return {
    mu,
    skyColor,
    horizonColor,
    fogNear,
    fogFar,
    ambientIntensity,
    moonIntensity,
    hemiSky: L.hemiSky,
    hemiGround: L.hemiGround,
    sunColor: L.sun,
    groundColor: L.ground,
    rainIntensity,
    railWetness,
    wiperOn,
    exposure,
    sunDir,
    sunColorPbr,
    bloomStrength,
    nightFactor,
  };
}

/** Deep-blue night → light overcast day, greyed by storminess. Returns hex RGB. */
function skyColorFor(time: TimeOfDay, storminess: number): number {
  // Base sky per time (deep blue night, warm-grey dusk, pale day).
  const base: Record<TimeOfDay, { r: number; g: number; b: number }> = {
    night: { r: 0x0a, g: 0x12, b: 0x28 }, // deep blue
    dusk: { r: 0x3a, g: 0x30, b: 0x40 }, // dim warm-violet
    day: { r: 0xb9, g: 0xc2, b: 0xcc }, // pale luminous blue-grey (not saturated cyan)
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
 * The horizon-band colour (R3): paler/brighter than the zenith by day (real skies
 * are brightest low), warm at dusk, and a touch lighter than the deep zenith at
 * night so the line silhouettes. Greyed by storminess like the sky. Returns hex RGB.
 */
function horizonColorFor(time: TimeOfDay, storminess: number): number {
  const base: Record<TimeOfDay, { r: number; g: number; b: number }> = {
    night: { r: 0x16, g: 0x22, b: 0x3c }, // faintly-lit deep-blue horizon
    dusk: { r: 0x4c, g: 0x3c, b: 0x44 }, // gentle warm-low — keeps the praised violet golden hour
    day: { r: 0xcd, g: 0xd2, b: 0xd2 }, // pale luminous haze, brighter than the zenith
  };
  const c = base[time];
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
