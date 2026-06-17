// World-level oracles for the Grand-World overhaul (HLD §2.0/§4).
//
// O17 (layering): an import-boundary guard proving the 1-D physics path never
// reaches the 3-D spatial core. The longitudinal dynamics + signalling modules
// (physics/simulation/controls/aws/train) must NOT import centerline/terrain/
// camera — those belong to the curvilinear spatial layer the render adapters
// consume. We assert this structurally by parsing each module's import
// specifiers from raw source, so a future careless `import` is caught here.
//
// O-RIBBON: the ground ribbon must never fold over itself on a curve, so the
// half-width is capped at half the tightest curve radius. Pinned for the
// terrain-rendered grand route (KINGSGATE_SEAHAVEN). WESTFORD_EASTBANK is a
// physics/signalling fixture that is never terrain-rendered, so it is EXEMPT.
//
// Pure test — no Three.js, no DOM, no wall-clock. Source text is read via Vite's
// `import.meta.glob(..., { query: '?raw' })`, which is statically transformed.

import { describe, it, expect } from "vitest";
import { minCurveRadius, KINGSGATE_SEAHAVEN, WESTFORD_EASTBANK } from "../src/sim/route";
import { qualityFor } from "../src/render/quality";

// ── O17 — layering guard (import-boundary) ───────────────────────────────────

describe("oracle O17: physics path never imports the spatial core", () => {
  // Read the raw source of every 1-D physics/signalling module. `import.meta.glob`
  // is a Vite transform replaced statically, so it MUST appear by its literal
  // name. The tsconfig omits the Vite client types, so the expression is cast.
  const physicsPathSources = (
    import.meta as unknown as {
      glob: (
        pattern: string | string[],
        opts: { query: string; import: string; eager: boolean },
      ) => Record<string, string>;
    }
  ).glob(
    [
      "../src/sim/physics.ts",
      "../src/sim/simulation.ts",
      "../src/sim/controls.ts",
      "../src/sim/aws.ts",
      "../src/sim/train.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  );

  // Parse the module specifiers out of every `... from "<spec>"` clause.
  const importSpecifiers = (src: string): string[] => {
    const re = /from\s+["']([^"']+)["']/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (spec !== undefined) out.push(spec);
    }
    return out;
  };

  // A spatial-core import is any specifier whose basename is one of these.
  const SPATIAL_CORE = ["centerline", "terrain", "camera"];
  const reachesSpatialCore = (spec: string): boolean =>
    SPATIAL_CORE.some((name) => spec === `./${name}` || spec.endsWith(`/${name}`));

  it("globbed all five physics-path modules (non-vacuous)", () => {
    const paths = Object.keys(physicsPathSources);
    expect(paths.length).toBe(5);
    for (const tail of ["physics.ts", "simulation.ts", "controls.ts", "aws.ts", "train.ts"]) {
      expect(paths.some((p) => p.endsWith(tail)), `missing ${tail}`).toBe(true);
    }
  });

  it("no physics-path module imports centerline / terrain / camera", () => {
    for (const [path, src] of Object.entries(physicsPathSources)) {
      const specs = importSpecifiers(src);
      const offenders = specs.filter(reachesSpatialCore);
      expect(offenders, `${path} imports the spatial core: ${offenders.join(", ")}`).toEqual([]);
    }
  });

  it("physics.ts has zero imports (the dynamics kernel depends on nothing)", () => {
    const entry = Object.entries(physicsPathSources).find(([p]) => p.endsWith("physics.ts"));
    expect(entry, "physics.ts not globbed").toBeDefined();
    // entry is defined by the assertion above; guard for noUncheckedIndexedAccess.
    const src = entry ? entry[1] : "";
    expect(importSpecifiers(src)).toEqual([]);
  });
});

// ── O-RIBBON — ground-ribbon half-width ≤ ½ tightest curve radius ─────────────

describe("oracle O-RIBBON: ribbonHalfWidth ≤ 0.5·minCurveRadius (terrain routes)", () => {
  const desktop = qualityFor({ coarsePointer: false, maxDevicePixelRatio: 2, reducedMotion: false });

  it("desktop ribbonHalfWidth (120) ≤ 0.5·minCurveRadius(KINGSGATE_SEAHAVEN)", () => {
    expect(desktop.ribbonHalfWidth).toBe(120);
    const radius = minCurveRadius(KINGSGATE_SEAHAVEN);
    expect(desktop.ribbonHalfWidth).toBeLessThanOrEqual(0.5 * radius);
    // The 240 m curvature floor the cap implies (ribbon 120 ⇒ minRadius ≥ 240).
    expect(radius).toBeGreaterThanOrEqual(240);
  });

  it("WESTFORD_EASTBANK is EXEMPT (a physics/signalling fixture, never terrain-rendered)", () => {
    // WESTFORD_EASTBANK carries no terrain set-pieces (no viaducts/tunnels), so it
    // is never terrain-rendered and O-RIBBON simply does not apply to it (HLD D25);
    // it keeps its tight 250 m curve regardless of the ribbon width.
    expect(WESTFORD_EASTBANK.viaducts).toBeUndefined();
    expect(WESTFORD_EASTBANK.tunnels).toBeUndefined();
    expect(minCurveRadius(WESTFORD_EASTBANK)).toBeCloseTo(250, 9);
  });
});
