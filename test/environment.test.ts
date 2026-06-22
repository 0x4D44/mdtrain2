import { describe, it, expect } from "vitest";
import {
  environmentParams,
  cycleEnvironment,
  DEFAULT_ENVIRONMENT,
  PRESET_RING,
} from "../src/sim/environment";
import type { TimeOfDay, Weather, Environment } from "../src/sim/environment";
import { ADHESION } from "../src/sim/train";

const TIMES: TimeOfDay[] = ["day", "dusk", "night"];
const WEATHERS: Weather[] = ["clear", "rain", "storm"];

describe("ENV1: wet conditions reduce adhesion", () => {
  it("rain.mu and storm.mu < clear.mu (same time); storm < rain", () => {
    for (const time of TIMES) {
      const clear = environmentParams({ time, weather: "clear" }).mu;
      const rain = environmentParams({ time, weather: "rain" }).mu;
      const storm = environmentParams({ time, weather: "storm" }).mu;
      expect(rain).toBeLessThan(clear);
      expect(storm).toBeLessThan(clear);
      expect(storm).toBeLessThan(rain);
    }
  });
});

describe("ENV2: night darker than dusk darker than day", () => {
  it("ambientIntensity and moonIntensity strictly increase night→dusk→day", () => {
    for (const weather of WEATHERS) {
      const night = environmentParams({ time: "night", weather });
      const dusk = environmentParams({ time: "dusk", weather });
      const day = environmentParams({ time: "day", weather });
      expect(night.ambientIntensity).toBeLessThan(dusk.ambientIntensity);
      expect(dusk.ambientIntensity).toBeLessThan(day.ambientIntensity);
      expect(night.moonIntensity).toBeLessThan(dusk.moonIntensity);
      expect(dusk.moonIntensity).toBeLessThan(day.moonIntensity);
    }
  });
});

describe("ENV3: rain/wiper iff weather !== clear", () => {
  it("clear ⇒ rainIntensity 0 and wiperOn false; otherwise > 0 and true", () => {
    for (const time of TIMES) {
      const clear = environmentParams({ time, weather: "clear" });
      expect(clear.rainIntensity).toBe(0);
      expect(clear.wiperOn).toBe(false);
      for (const weather of ["rain", "storm"] as Weather[]) {
        const p = environmentParams({ time, weather });
        expect(p.rainIntensity).toBeGreaterThan(0);
        expect(p.wiperOn).toBe(true);
      }
    }
  });
});

describe("ENV4: calibration pins", () => {
  it("default (rainy day) μ is exactly 0.25 within 1e-9", () => {
    const mu = environmentParams(DEFAULT_ENVIRONMENT).mu;
    expect(Math.abs(mu - 0.25)).toBeLessThan(1e-9);
  });

  it("the wet-night preset still pins μ == ADHESION.wetNight (0.20)", () => {
    const mu = environmentParams({ time: "night", weather: "rain" }).mu;
    expect(Math.abs(mu - 0.2)).toBeLessThan(1e-9);
    expect(Math.abs(mu - ADHESION.wetNight)).toBeLessThan(1e-9);
  });
});

describe("ENV5: finite outputs, μ ≥ 0.15, rain/wetness ∈ [0,1]", () => {
  it("across the full TimeOfDay × Weather domain", () => {
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        const p = environmentParams({ time, weather });
        const all = [
          p.mu,
          p.skyColor,
          p.fogNear,
          p.fogFar,
          p.ambientIntensity,
          p.moonIntensity,
          p.hemiSky,
          p.hemiGround,
          p.sunColor,
          p.groundColor,
          p.rainIntensity,
          p.railWetness,
          // new scalar realism fields (sunDir is a vector — checked below)
          p.exposure,
          p.bloomStrength,
          p.sunColorPbr,
        ];
        for (const v of all) {
          expect(Number.isFinite(v)).toBe(true);
        }
        // sunDir is a vector, not a number slot — check its components.
        expect(Number.isFinite(p.sunDir.x)).toBe(true);
        expect(Number.isFinite(p.sunDir.y)).toBe(true);
        expect(Number.isFinite(p.sunDir.z)).toBe(true);
        expect(p.mu).toBeGreaterThanOrEqual(0.15);
        expect(p.rainIntensity).toBeGreaterThanOrEqual(0);
        expect(p.rainIntensity).toBeLessThanOrEqual(1);
        expect(p.railWetness).toBeGreaterThanOrEqual(0);
        expect(p.railWetness).toBeLessThanOrEqual(1);
      }
    }
  });

  // The μ ≥ 0.15 guard above is satisfied with margin: the lowest μ any valid
  // environment can produce is night × storm = 0.20 × 0.8 = 0.16, which sits
  // ABOVE the MU_FLOOR (0.15). So the clamp never bites in-domain — it is a
  // deliberate defensive guard, not a reachable path. Pin both facts so a future
  // tune that drops the in-domain minimum below the floor is caught here.
  it("the in-domain minimum μ is night×storm = 0.16, just above the 0.15 floor", () => {
    let min = Infinity;
    let argmin: Environment = DEFAULT_ENVIRONMENT;
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        const mu = environmentParams({ time, weather }).mu;
        if (mu < min) {
          min = mu;
          argmin = { time, weather };
        }
      }
    }
    expect(Math.abs(min - 0.16)).toBeLessThan(1e-9);
    expect(argmin).toEqual({ time: "night", weather: "storm" });
    expect(min).toBeGreaterThan(0.15); // floor is a guard below the in-domain min
  });
});

describe("O10: exposure & bloomStrength ordered (documented direction)", () => {
  // exposure is a function of time only: brighter daylight ⇒ higher exposure.
  // Documented order: day > dusk > night (more daylight ⇒ pull exposure up).
  it("exposure strictly decreases day → dusk → night (for every weather)", () => {
    for (const weather of WEATHERS) {
      const day = environmentParams({ time: "day", weather }).exposure;
      const dusk = environmentParams({ time: "dusk", weather }).exposure;
      const night = environmentParams({ time: "night", weather }).exposure;
      expect(day).toBeGreaterThan(dusk);
      expect(dusk).toBeGreaterThan(night);
    }
  });

  // bloomStrength is per time×weather. Documented order: darker time ⇒ more bloom
  // (lamp halos read in the dark), so for a fixed weather night > dusk > day; and
  // night×rain is the GLOBAL maximum (the signature wet-night lamp halos).
  it("bloomStrength strictly increases day → dusk → night (for every weather)", () => {
    for (const weather of WEATHERS) {
      const day = environmentParams({ time: "day", weather }).bloomStrength;
      const dusk = environmentParams({ time: "dusk", weather }).bloomStrength;
      const night = environmentParams({ time: "night", weather }).bloomStrength;
      expect(dusk).toBeGreaterThan(day);
      expect(night).toBeGreaterThan(dusk);
    }
  });

  it("night×rain is the unique strongest bloomStrength over the whole domain", () => {
    const target = environmentParams({ time: "night", weather: "rain" }).bloomStrength;
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        if (time === "night" && weather === "rain") continue;
        const b = environmentParams({ time, weather }).bloomStrength;
        expect(b).toBeLessThan(target);
      }
    }
  });
});

describe("O11: sunDir is a unit vector everywhere", () => {
  it("|sunDir| === 1 (≤1e-9) for every time × weather", () => {
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        const { sunDir } = environmentParams({ time, weather });
        const len = Math.sqrt(
          sunDir.x * sunDir.x + sunDir.y * sunDir.y + sunDir.z * sunDir.z,
        );
        expect(Math.abs(len - 1)).toBeLessThanOrEqual(1e-9);
      }
    }
  });
});

describe("O12: new fields pure & finite across the domain", () => {
  it("exposure>0, bloomStrength≥0, sunColorPbr & sunDir finite for every Environment", () => {
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        const p = environmentParams({ time, weather });
        expect(Number.isFinite(p.exposure)).toBe(true);
        expect(p.exposure).toBeGreaterThan(0);
        expect(Number.isFinite(p.bloomStrength)).toBe(true);
        expect(p.bloomStrength).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(p.sunColorPbr)).toBe(true);
        expect(Number.isFinite(p.sunDir.x)).toBe(true);
        expect(Number.isFinite(p.sunDir.y)).toBe(true);
        expect(Number.isFinite(p.sunDir.z)).toBe(true);
        expect(Number.isFinite(p.nightFactor)).toBe(true);
        expect(p.nightFactor).toBeGreaterThanOrEqual(0);
        expect(p.nightFactor).toBeLessThanOrEqual(1);
        expect(Number.isFinite(p.horizonColor)).toBe(true);
        expect(p.horizonColor).toBeGreaterThanOrEqual(0);
        expect(p.horizonColor).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it("is a pure function — same input gives an equal result", () => {
    for (const time of TIMES) {
      for (const weather of WEATHERS) {
        const a = environmentParams({ time, weather });
        const b = environmentParams({ time, weather });
        expect(a.exposure).toBe(b.exposure);
        expect(a.bloomStrength).toBe(b.bloomStrength);
        expect(a.sunColorPbr).toBe(b.sunColorPbr);
        expect(a.sunDir).toEqual(b.sunDir);
        expect(a.nightFactor).toBe(b.nightFactor);
        expect(a.horizonColor).toBe(b.horizonColor);
      }
    }
  });
});

describe("O13: nightFactor ordered & bounded (celestial-layer visibility)", () => {
  // Time-only: the celestial layer is washed out by day and full at night, with a
  // faint hint at dusk. Strictly increasing day < dusk < night for every weather;
  // pinned at the endpoints so scene.ts can rely on 0 = fully off, 1 = full.
  it("strictly increases day → dusk → night (for every weather)", () => {
    for (const weather of WEATHERS) {
      const day = environmentParams({ time: "day", weather }).nightFactor;
      const dusk = environmentParams({ time: "dusk", weather }).nightFactor;
      const night = environmentParams({ time: "night", weather }).nightFactor;
      expect(dusk).toBeGreaterThan(day);
      expect(night).toBeGreaterThan(dusk);
    }
  });

  it("is exactly 0 by day and 1 at night (weather-independent)", () => {
    for (const weather of WEATHERS) {
      expect(environmentParams({ time: "day", weather }).nightFactor).toBe(0);
      expect(environmentParams({ time: "night", weather }).nightFactor).toBe(1);
    }
  });
});

describe("ENV6: cycleEnvironment walks the ring back to default", () => {
  it("returns to DEFAULT_ENVIRONMENT after PRESET_RING.length steps", () => {
    let env: Environment = DEFAULT_ENVIRONMENT;
    for (let i = 0; i < PRESET_RING.length; i++) {
      env = cycleEnvironment(env);
    }
    expect(env).toEqual(DEFAULT_ENVIRONMENT);
  });

  it("each step yields a valid Environment", () => {
    let env: Environment = DEFAULT_ENVIRONMENT;
    for (let i = 0; i < PRESET_RING.length * 2; i++) {
      env = cycleEnvironment(env);
      expect(TIMES).toContain(env.time);
      expect(WEATHERS).toContain(env.weather);
    }
  });

  it("a non-ring environment falls back to the ring head", () => {
    const outsider: Environment = { time: "day", weather: "storm" };
    expect(cycleEnvironment(outsider)).toEqual(PRESET_RING[0]);
  });

  it("DEFAULT_ENVIRONMENT is the ring head", () => {
    expect(PRESET_RING[0]).toEqual(DEFAULT_ENVIRONMENT);
  });
});
