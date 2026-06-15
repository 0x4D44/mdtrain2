# HLD — mdtrain2 World Overhaul: "The Night Cab" (RISK-FIRST angle)

**Status:** DRAFT · Date 2026-06-15 · Angle: **RISK-FIRST** · Author: drafter (DRAFT phase, ultracode HLD campaign)
**Provenance:** lead-authored against current HEAD (Phase 0–5 merged, v0.10.0). Target `C:\language\mdtrain2`. This is a *world overhaul*: a living terrain heightfield the line threads through, a realism pass (PBR / ACES tone-map / shadows / sky), and a longer multi-chapter signature route. `package.json` 0.10.0 → 0.11.0.
**One-line thesis:** the centrepiece is **one pure parametric centreline + terrain field** (testable math, no banned tokens) that everything anchors to; everything *risky* (frame budget, bundle, motion-sickness, geometric self-intersection, LOD popping, fog/clipping) is neutralised by a **quality tier with kill-switches** and a fistful of **analytic oracles**. If a switch is off, that subsystem renders nothing and the build still passes.

This draft leads with the **failure modes** and designs backward from them. Every risk **R-n** has a named mitigation and a check (oracle **On** or smoke **SMOKE-n**).

---

## 0. Risk register (lead with the failure modes)

| # | Failure mode | Why it bites | Mitigation (named) | Check |
|---|---|---|---|---|
| **R1** | **Mobile frame budget** blown by a full-route heightfield | A 13 km × 400 m field at 2 m resolution = ~1.3 M verts; phones die | **Track-following ribbon** ±180 m, chunked, distance-LOD; geometry detail + shadows + bloom gated by `quality.tier` | O12, O13, SMOKE-2 |
| **R2** | **Bundle size** balloons past static-host friendliness | Committed textures / EffectComposer can add MBs | **Zero committed image assets** (procedural canvas textures); bloom is a *gated* `three/examples` import (not a dep); budget assertion | O14, BUILD |
| **R3** | **Determinism leakage** trips the G3 grep guard | Terrain/centreline live in `src/sim`; any `Math.random`/`Date`/`performance.now` fails the build | Seeded **value-noise** (integer hash, no `Math.random`); no wall-clock; G3 already greps `src/sim/*.ts` | O11 (G3), O10 |
| **R4** | **Camera motion-sickness** from pitch/roll on the viaduct/curves | Cant roll + grade pitch coupled to the eye nauseates | **Decision D7:** cab/eye rides **clamped, eased, fractional** frame attitude (pitch/roll scaled + low-pass), never raw; horizon kept stable | O8, O9, SMOKE-4 |
| **R5** | **Track-vs-terrain drift** — rails float or sink into the field | Two independent height sources diverge at segment joints | Terrain is **defined from** the centreline (`formationHeight(s)=centerline.y`); rails sample the *same* `centerlineAt`; C1 continuity proven | O3, O4, O7 |
| **R6** | **Viaduct / tunnel self-intersection** with terrain | A viaduct deck under the natural ground, or a tunnel bored through open air, looks broken | Structures are **placed by the signed difference** `d(s,x)=natural−formation`; viaduct only where `d` deep+negative, tunnel only where `d` tall+positive; portal/deck clamped to terrain at portals | O5, O6, SMOKE-3 |
| **R7** | **LOD popping** as ribbon chunks swap detail | Visible geometry jumps at chunk boundaries while moving | **Skirts** + **vertex-welded chunk seams** + hysteresis on LOD band switch; no topology change within a chunk's lifetime | O13, SMOKE-5 |
| **R8** | **Fog / near-clip artefacts** with a pitching camera | Pitch up → camera ducks under terrain or fog far-plane clips the viaduct | Eye height clamped **above local terrain + min clearance**; fog far scales with chapter; near-plane unchanged (0.05) | O9, SMOKE-4 |
| **R9** | **Regression** of the 164 tests / physics | Physics must keep using 1D `gradeAt`; sim must stay pure | 3D path is **additive**; physics does **not** import `centerline.ts`; REG oracle | O15 (REG), O11 |
| **R10** | **Per-frame allocation** in the new hot paths (ribbon update, camera frame) | GC stutter on mobile | Pre-allocated scratch vectors/typed arrays; ribbon updates by **rewriting** existing buffers; zero-alloc assertion in review | O16, SMOKE-2 |

The rest of the document is structured to discharge every row above.

---

## 1. Scope & non-goals

### In scope
1. **Pure parametric centreline** (`src/sim/centerline.ts`, NEW, PURE, TESTED) — `centerlineAt(route, s)` returns the 3D frame `{ position{x,y,z}, tangent, up, cant }` plus helpers `heightAt`, `lateralOffsetAt`, `frameAt`. Analytic, C1-continuous, seeded-deterministic. The **prime testable seam** (unanimous across readers).
2. **Pure terrain field** (`src/sim/terrain.ts`, NEW, PURE, TESTED) — `terrainHeight(route, s, x)` blending the rail formation near the track with seeded rolling natural ground far out; plus `featureAt(route, s)` classifying each chainage as `CUTTING | EMBANKMENT | VIADUCT | TUNNEL | OPEN`. Pure, no banned tokens.
3. **Grand route** (`src/sim/route.ts`, CHG — new `NIGHT_CAB` Route constant; **existing `WESTFORD_EASTBANK` kept** for the 164 tests) — a longer multi-chapter line (city terminus → suburb → countryside → **viaduct** → coast → **tunnel** → terminus), ~**13.2 km**, with grade/curvature/speed/station/signal data that *drive* the centreline and terrain.
4. **Terrain ribbon renderer** (`src/render/terrainRibbon.ts`, NEW, impure adapter) — a track-following heightfield mesh (±180 m), chunked with distance-LOD, sampling `terrainHeight`. Procedural PBR materials (grass/ballast/rock/water). Zero per-frame allocation.
5. **Set-piece structures** (`src/render/structures.ts`, NEW, impure adapter) — the **viaduct** (piered deck spanning the river valley), **tunnel portals + bore**, cuttings/embankment finishing, all placed from `featureAt` + `centerlineAt` at build time.
6. **Realism pass** (`src/render/realism.ts`, NEW, impure adapter + `src/sim/realism.ts`, NEW, PURE, TESTED) — ACES tone-mapping + exposure, ONE shadow-casting sun (PCFSoft), optional bloom (gated `three/examples`), sky dome + PMREM env map, procedural normal-mapped PBR materials. The pure half (`realismParams`) extends `EnvironmentParams` with realism knobs.
7. **Camera/cab on the centreline frame** (`src/render/scene.ts` + `cab.ts`, CHG) — camera position/yaw/pitch/roll from `frameAt`, plus the existing LMB look offset; cab rides a **clamped/eased fraction** of frame pitch/roll (Decision **D7**).
8. **Quality tier extended** (`src/render/quality.ts`, CHG, PURE, TESTED) — `qualityFor` gains a discrete `tier: "low" | "mid" | "high"` and the kill-switches `shadowsEnabled`, `bloomEnabled`, `bloomStrength`, `ribbonHalfWidth`, `ribbonChunkLen`, `terrainResolution`, `attitudeScale`.

### Non-goals
- No switches/junctions/branching track — the route is a single line (the centreline is a 1-parameter curve in `s`).
- No multiplayer, no timetable rewrite, no new signalling rules (signals still `aspectAt`; the grand route just has more of them).
- No imported 3D model files (`.glb`/`.fbx`), **no committed image textures** — everything procedural to keep the bundle static-host tiny.
- No erosion/hydrology sim, no dynamic terrain — the field is **built once** (props anchor at build time), consistent with today's "build scenery once" rule.
- No new **runtime npm dependency**. `three/examples/...` sub-imports (EffectComposer, UnrealBloomPass, Sky) are **not** new deps (per brief). No new env vars; **no feature flags** — only the pure quality tier.
- Not removing `WESTFORD_EASTBANK`: it stays as the physics/signalling test fixture so the 164 tests are untouched. The app boots on `NIGHT_CAB`.

---

## 2. The design

The whole overhaul rests on **one diagram in your head**:

```
                centerlineAt(route, s)  ──►  {position, tangent, up, cant}   (PURE)
                        │                              │
        formationHeight(s)=position.y                  ├──► camera/cab frame (impure)
                        │                              ├──► rails/sleepers/structures anchor (impure)
                        ▼                              │
   terrainHeight(route,s,x) = blend(formation, natural(s,x))  (PURE)
                        │
        d(s,x)=natural−formation ──► featureAt(s): CUTTING/EMBANKMENT/VIADUCT/TUNNEL  (PURE)
                        │
            terrainRibbon (impure) + structures (impure) read the PURE field
```

Pure math in `src/sim` (tested, oracle-guarded, determinism-clean). Three.js/DOM are **named untested adapters** verified by build + headless screenshots — exactly the Phase 3–5 pattern.

### 2.1 `src/sim/centerline.ts` (NEW, PURE, TESTED) — the prime seam

The line is a **1-parameter space curve** `s ∈ [0, route.length]`. Position is built from three independent integrals of existing route data, so it is analytic and has analytic oracles.

```ts
export interface Frame {
  position: { x: number; y: number; z: number };
  tangent:  { x: number; y: number; z: number }; // unit, direction of increasing s
  up:       { x: number; y: number; z: number }; // unit, tilted by cant
  cant:     number;                               // superelevation roll angle, rad (right-down +)
}

/** Vertical profile: y(s) = ∫₀ˢ grade(u) du  (piecewise-linear grade ⇒ piecewise-quadratic y). */
export function heightAt(route: Route, s: number): number;

/** Plan offset from the nominal straight axis, m, from curvature:
 *  a constant-curvature arc of radius R over angle θ deflects laterally by R(1−cosθ).
 *  Accumulated piecewise so the plan is C1 (no kink) at segment joins. */
export function lateralOffsetAt(route: Route, s: number): { x: number; z: number; heading: number };

/** Cant (superelevation) from curvature & speed limit: cant = clamp(k·v²·κ, ±CANT_MAX). Smooth ramp. */
export function cantAt(route: Route, s: number): number;

/** Full frame at chainage s (position incl. y, unit tangent, canted up, cant angle). */
export function frameAt(route: Route, s: number): Frame;

/** Convenience identical to frameAt(...).position. */
export function centerlineAt(route: Route, s: number): Frame; // alias used in prose
```

**Math, precisely (the load-bearing definitions):**

- **Vertical** `y(s) = Σ over fully-covered grade segments (gᵢ·Δᵢ) + g_cur·(s − segStart)`. Grades are piecewise-constant (today's `route.grades`), so `y` is **piecewise-linear → C0 and continuous slope-bounded**; we *smooth the slope* by treating grade as a short linear ramp (vertical transition curve) of length `VT_RAMP = 60 m` centred on each grade change, making `y` **C1** (no kink ⇒ no camera-pitch snap, R4/R8).
- **Plan** integrates heading `ψ(s) = ψ₀ + ∫ κ(u) du` with `κ = curvatureAt`. Then `x(s) = ∫ sin ψ`, `z_plan(s) = ∫ cos ψ`. We map the nominal axis to **world +Z = forward** (today's convention) by using `z ≈ s` for small deflections and carrying the lateral `x` offset; the existing scene already treats `+Z` as chainage, so straight-route screenshots are unchanged when `κ ≡ 0` (**R5 continuity, regression-friendly**). Curvature is piecewise-constant today; we ramp κ over `TRANS_RAMP = 40 m` at each change so `ψ` is C1 and `x` is C2 — **no plan kink** (R4).
- **Cant** `cant(s) = clamp(CANT_K · v(s)² · κ(s), −CANT_MAX, +CANT_MAX)`, with `v = speedLimitAt`, ramped over the same `TRANS_RAMP`. `CANT_MAX ≈ 0.10 rad` (~6°, realistic UK max ~150 mm on 1.435 m gauge). This is the *track* cant; the camera only takes a **fraction** of it (D7).

**Integration strategy (zero-alloc, deterministic):** `route.grades/curvatures` are short arrays; `heightAt`/`lateralOffsetAt` integrate **analytically per segment** (closed form for piecewise-constant-with-ramp), so a lookup is `O(segments)` with **no allocation** and **no iterative stepping** — exact, not Riemann-summed. This is what makes the oracles *analytic* (O3–O7) rather than tolerance-bashed.

Constants live as exported `const` (e.g. `VT_RAMP`, `TRANS_RAMP`, `CANT_K`, `CANT_MAX`) so tests pin them.

### 2.2 `src/sim/terrain.ts` (NEW, PURE, TESTED) — the living land

```ts
export type Feature = "OPEN" | "CUTTING" | "EMBANKMENT" | "VIADUCT" | "TUNNEL";

/** Rail formation height at chainage s == the centreline y (single source of truth). */
export function formationHeight(route: Route, s: number): number; // = heightAt(route, s)

/** Natural rolling ground, seeded value-noise (NO Math.random/Date). Smooth, C1. */
export function naturalGround(route: Route, s: number, x: number): number;

/** The terrain surface the ribbon renders: blend formation (near track) → natural (far). */
export function terrainHeight(route: Route, s: number, x: number): number;

/** Classify the lineside profile at s from the signed difference on the track centre. */
export function featureAt(route: Route, s: number): Feature;
```

**Blend math (the centrepiece formula):**

Let `f = formationHeight(s)`, `n = naturalGround(s, x)`, and `a = |x|` the lateral distance from track centre.

```
ballastShoulder(a) = f + BALLAST_TOP            for a ≤ HALF_FORMATION         (the flat trackbed)
blend weight  w(a) = smoothstep(HALF_FORMATION, BLEND_FAR, a)   ∈ [0,1]
terrainHeight      = (1 − w)·ballastShoulder(a) + w·n
```

- Near the track (`a ≤ HALF_FORMATION ≈ 4 m`): pure **flat formation** + ballast shoulder — rails always sit on level bed (R5: rails never float/sink).
- Transition (`HALF_FORMATION < a < BLEND_FAR ≈ 30 m`): smoothstep blend — this *is* the cutting wall / embankment batter, emerging **for free** from the difference between formation and land.
- Far (`a ≥ BLEND_FAR`): pure **natural rolling ground**.

The **signed difference at the track edge** drives the feature classifier:
```
d(s) = naturalGround(s, HALF_FORMATION) − formationHeight(s)
featureAt(s) =
  VIADUCT     if d < −VIADUCT_THRESHOLD   (land far below formation → span a valley)
  EMBANKMENT  if −VIADUCT_THRESHOLD ≤ d < −EMB_THRESHOLD
  TUNNEL      if d >  TUNNEL_THRESHOLD     (land far above formation → bore through hill)
  CUTTING     if  CUT_THRESHOLD < d ≤ TUNNEL_THRESHOLD
  OPEN        otherwise
```
This guarantees **R6**: a viaduct is *only* emitted where the land is genuinely far below the rail (a valley); a tunnel *only* where it's far above (a hill). Structure placement cannot contradict the terrain because both read the same `d(s)`.

**`naturalGround` determinism (R3):** seeded 2-octave value noise built from an **integer hash** of quantised `(s, x)` lattice cells with smoothstep interpolation — pure arithmetic, **no `Math.random`, no `Date`, no `performance.now`**. The river valley and the hill are **authored, not random**: `naturalGround` adds a deterministic *valley basin* term keyed to the chapter chainages (a smooth negative Gaussian over the river crossing) and a *hill ridge* term over the tunnel chapter, then sprinkles small noise. So the set-pieces land exactly where the route author wants them, every run.

### 2.3 `src/sim/route.ts` (CHG) — the grand route `NIGHT_CAB`

`WESTFORD_EASTBANK` **stays** (test fixture). Add `NIGHT_CAB` (new export) and boot the app on it. Same `Route` interface (still pure 1D — the centreline/terrain *interpret* it; `route.ts` gains **no** 3D fields, keeping the type tested as-is).

**Chapters & chainages (~13.2 km, 7 set-pieces):**

| Chapter | Chainage (m) | Set-piece | Terrain intent | Speed feel |
|---|---|---|---|---|
| **1. City terminus** | 0 – 1 200 | "King's Vault" terminus throat: tight curves, signal gantry density, brick retaining **cuttings** | land slightly above formation → shallow cutting | 15→25 mph, restrictive |
| **2. Suburb** | 1 200 – 3 400 | "Ashfield" station, overbridges, back-gardens (distant blocks), platform crowds | gentle, OPEN/shallow cutting | 25→50 mph |
| **3. Countryside climb** | 3 400 – 6 200 | open fields, rolling **embankment** carrying the line above pasture, fences, tree clumps | land falls below formation → embankment banks | 50→70 mph, 1.2% climb |
| **4. River valley + VIADUCT** | 6 200 – 7 600 | the **great viaduct** over the river "Aln": multi-arch/piered deck, water below, deep valley | `d ≪ 0` → VIADUCT span | 60 mph, gentle curve onto the deck |
| **5. Coast** | 7 600 – 9 800 | "Sea Mills" halt; the line runs along an embankment beside the estuary, big sky, wet reflections | embankment + flat sea plane far out | 45→55 mph |
| **6. Headland TUNNEL** | 9 800 – 11 400 | bore through the coastal **headland**: portal, dark bore, lamp pools, emerge the far side | `d ≫ 0` → TUNNEL | 40 mph, AWS magnet at portal |
| **7. Eastbank terminus** | 11 400 – 13 200 | "Eastbank" arrival: falling grade into buffer stops, urban again | shallow cutting → OPEN | 45→15 mph into the stops |

Stations (≈7), grades, speedLimits, curvatures, and signals authored so the centreline & terrain produce these set-pieces. The river-valley & headland are pinned in `naturalGround`'s authored valley/ridge terms keyed to chapters 4 and 6 (deterministic, R3). The viaduct/tunnel placement is then *derived* by `featureAt`, so the data is **self-consistent** (R6).

### 2.4 `src/render/terrainRibbon.ts` (NEW, impure adapter) — the heightfield

A **track-following ribbon**, not a world grid (R1). It is the single biggest perf lever.

```ts
export interface RibbonOptions {
  halfWidth: number;       // ±m sampled either side of track  (tier-gated: low 120, high 200)
  chunkLen: number;        // m of chainage per chunk           (e.g. 240)
  resolution: number;      // lateral+longitudinal sample step, m (tier-gated: low 6, high 2)
  view: { near: number; far: number }; // LOD bands, m of chainage ahead
}
export interface TerrainRibbon {
  /** Re-centre the ribbon on chainage s; rewrites existing chunk buffers in place. */
  update(s: number): void;
}
export function buildTerrainRibbon(scene: THREE.Scene, route: Route, opts: RibbonOptions): TerrainRibbon;
```

- The ribbon is a ring of **N pre-allocated chunks** covering `[s − back, s + far]`. As the train advances, the rearmost chunk is **recycled to the front** and its vertex buffer **rewritten** from `terrainHeight` (R10: zero allocation — buffers are reused, never re-`new`'d).
- Each chunk's vertices sample `terrainHeight(route, s_i, x_j)` and lay them out in the **centreline frame** at `s_i` (so the ribbon curves and rises with the line — R5: the ribbon and rails share `centerlineAt`).
- **LOD (R7):** chunks beyond `view.near` use the coarse `resolution`; near chunks use fine. To kill **popping**: (a) **skirts** — each chunk's border verts drop `SKIRT_DROP` below the surface so a coarse/fine seam never shows a gap; (b) **welded seams** — adjacent chunks share identical border-vertex heights (both sample the exact same `terrainHeight` at the shared `s,x`), so there is no crack; (c) **hysteresis** — a chunk only changes LOD band when it crosses `view.near ± HYST`, never oscillating at the boundary.
- **Materials:** procedural PBR (R2) — see §2.6. Vertex colour / a splat weight selects grass vs. ballast vs. rock vs. water by `featureAt`/height, so one material covers the ribbon (no per-feature mesh explosion).

### 2.5 `src/render/structures.ts` (NEW, impure adapter) — the set-pieces

Built **once** from `featureAt` + `centerlineAt` (consistent with today's build-once rule).

- **Viaduct** (R6): over each `VIADUCT` run, emit a deck (box following the centreline frame) carried on **piers** that drop from the deck soffit to `naturalGround` at each pier foot. Pier height = `formationHeight − naturalGround` at that `s`, so piers **always reach the ground** (no floating/short piers). Parapets along both deck edges. Arches optional (instanced) on `high` tier only.
- **Tunnel** (R6): over each `TUNNEL` run, emit two **portals** (head walls clamped to the hillside terrain at the portal chainage) and a dark **bore** (an inward-facing tube around the centreline) with periodic lamp pools (emissive + ranged point light, reusing the station-lamp recipe). The bore radius clears the loading gauge by a fixed margin; the surrounding terrain is *not* drawn inside the hill (the ribbon's natural ground forms the hillside above).
- **Cutting/embankment finishing**: the ribbon's blend already forms the banks; structures.ts only adds retaining walls in the urban chapters (1, 7) where a brick wall reads better than a grass batter.
- Portals, deck ends, and retaining walls **clamp to `terrainHeight`** at their anchor chainage (R6/R5: no structure floats or buries).

### 2.6 Realism — `src/sim/realism.ts` (PURE, TESTED) + `src/render/realism.ts` (impure)

**Pure half** extends the environment with realism knobs (keeps it testable, like `environmentParams`):

```ts
export interface RealismParams {
  exposure: number;                 // ACES toneMappingExposure
  sun: { dir:{x,y,z}; color:number; intensity:number }; // shadow-casting key light
  bloomStrength: number;            // 0 when gated off
  envIntensity: number;             // PMREM env-map contribution to PBR
}
export function realismParams(env: Environment, q: QualitySettings): RealismParams;
```
`exposure`/sun direction/colour follow time-of-day (sun low & warm at dusk, moon-cool at night — reuse `LIGHTING`); `bloomStrength = q.bloomEnabled ? base : 0`. Pure mapping, oracle O17.

**Impure half** applies them to the renderer (named adapter, screenshot-verified):
- `renderer.toneMapping = ACESFilmicToneMapping; toneMappingExposure = exposure` — **free**, biggest visual win.
- **ONE** shadow-casting `DirectionalLight` (the sun) with `PCFSoftShadowMap`, **gated by `q.shadowsEnabled`** (off on `low` tier). Shadow camera is a tight ortho box that **follows the train** (covers ±~120 m so the viaduct/cutting cast real shadows without a 4 K map). `shadow.mapSize` tier-gated (1024 high / off low).
- **Bloom** via `three/examples/jsm/postprocessing/EffectComposer` + `UnrealBloomPass`, **gated by `q.bloomEnabled`** (off on low/mid). When off, render straight to screen (no composer) — so the import is **tree-shakeable** and the low-tier path never pays for it (R2).
- **Sky**: `three/examples/jsm/objects/Sky` dome (or a gradient dome on low tier) + a **PMREMGenerator** env map baked **once** from the sky for PBR reflections (`scene.environment`). Wet rails/water then reflect a real sky. Env map rebuilt only when the environment preset changes (not per frame).
- **Procedural textures (R2 — NO committed assets):** canvas-generated albedo + normal maps for grass, ballast, rock, water, built once at startup (like today's `makeGlowTexture`). Normal maps give PBR surfaces micro-relief without image files. Water uses an animated normal scroll (phase advanced by the single `dt`, in the impure layer only — no banned tokens in `src/sim`).

**Mobile scale-down (every technique degrades, never breaks):**

| Technique | low tier (mobile) | mid | high (desktop) |
|---|---|---|---|
| ACES tone-map + exposure | on (free) | on | on |
| Shadows | **off** | on, 1024, ±80 m | on, 1024, ±120 m |
| Bloom | **off** (no composer) | off | on (gated import) |
| Sky | gradient dome | Sky shader | Sky + PMREM env |
| PMREM env map | off (flat env) | on | on |
| Ribbon halfWidth / res | 120 m / 6 m | 160 m / 4 m | 200 m / 2 m |
| pixelRatioCap | ≤1.5 | ≤2 | ≤2 |

### 2.7 `src/render/quality.ts` (CHG, PURE, TESTED) — the kill-switch tier

`qualityFor` gains a discrete tier and the switches. **These are not feature flags** — they're a pure function of device capability, defaulting desktop to *all on* (so high-tier is the "intended" experience and low-tier the safety net):

```ts
export type Tier = "low" | "mid" | "high";
export interface QualitySettings {
  pixelRatioCap: number; rainCount: number;            // existing
  tier: Tier;
  shadowsEnabled: boolean; shadowMapSize: number;
  bloomEnabled: boolean;   bloomStrength: number;
  ribbonHalfWidth: number; ribbonChunkLen: number; terrainResolution: number;
  attitudeScale: number;   // fraction of frame pitch/roll the camera takes (R4)
}
export function qualityFor(env: QualityEnv): QualitySettings;
```
- `coarsePointer` ⇒ `low` (shadows/bloom off, narrow coarse ribbon, `attitudeScale` 0). `reducedMotion` forces `attitudeScale = 0` and `rainCount = 0` regardless of tier (R4/accessibility). Desktop ⇒ `high`.
- A `?tier=` override is **not** added (no env-var/flag creep); the tier is derived. (Decision D8.)

### 2.8 `src/render/scene.ts` + `cab.ts` (CHG) — camera/cab on the frame

Per frame, replace today's straight-axis camera math with the centreline frame:

```ts
const f = frameAt(route, view.chainage);             // pure
// camera base attitude from the frame, plus the existing LMB look offset:
camYaw   = BASE_YAW + headingFromTangent(f.tangent) + lookYaw;
camPitch = f.pitch * q.attitudeScale  + lookPitch;   // grade pitch, scaled+eased (R4)
camRoll  = f.cant  * q.attitudeScale;                // cant roll,  scaled+eased (R4)
camera.position.set(f.position.x + EYE_X_lateral, eyeY, f.position.z);
```
- **eyeY** = `f.position.y + EYE_HEIGHT`, then **clamped** to `≥ terrainHeight(route, s, EYE_X) + MIN_CLEARANCE` so the eye never ducks under the land when pitching (R8). `EYE_X` is applied **in the frame's lateral direction** so the driver stays left-of-centre through curves.
- **Easing (R4):** `camPitch`/`camRoll`/the heading are passed through a **critically-damped low-pass** (`approach()` from physics.ts, reused — pure, already tested) so a grade/curve change eases in over ~0.3 s rather than snapping. `attitudeScale ∈ [0,1]` (0 on low/reduced-motion = today's flat ride; ~0.4 on high = gentle, gorgeous, *not* nauseating).
- **Cab fork — Decision D7 (resolved):** the cab rides the **same eased fractional attitude as the eye** (yaw + scaled pitch/roll), NOT raw. The cab and the eye move together, so the cab frame stays fixed relative to the driver's head (no relative sloshing) while the *world* tilts gently on the viaduct. This is the realism win without the sickness, because the horizon motion is small (`attitudeScale·cant`), eased, and zero on mobile/reduced-motion. (Dissent + rationale in §6.)
- Rails/sleepers/signals/scenery `z`-placement is replaced by **placement in the frame at their chainage** (`frameAt(route, obj.chainage)`), so everything threads the same curve and sits on the same formation (R5). Done once at build (signals/masts/fences) or via instancing along sampled `s`.
- `fog.far` scales with chapter/tier; near-plane stays `0.05` (R8 — no near-clip change). On the viaduct the open valley wants a longer `fogFar`; `environmentParams` already exposes fog and we extend it per-chapter via a pure `fogFarFor(featureAt(s))` multiplier.

### 2.9 What stays pure / untested

- **Pure + tested (`src/sim`, G3-clean):** `centerline.ts`, `terrain.ts`, `realism.ts`, the `NIGHT_CAB` data in `route.ts`, the extended `quality.ts`.
- **Untested impure adapters (named, screenshot-verified):** `terrainRibbon.ts`, `structures.ts`, `render/realism.ts`, the `scene.ts`/`cab.ts` camera-frame plumbing. These touch Three.js/WebGL/canvas/`dt` and are verified by **build + headless screenshots**, never unit-tested.

---

## 3. File-level impact map

| File | Action | Pure/impure | Why |
|---|---|---|---|
| `src/sim/centerline.ts` | **NEW** | pure, tested | The prime seam: `frameAt/heightAt/lateralOffsetAt/cantAt`. Analytic, C1, seeded. |
| `src/sim/terrain.ts` | **NEW** | pure, tested | `terrainHeight` blend + `featureAt` classifier + seeded `naturalGround`. |
| `src/sim/realism.ts` | **NEW** | pure, tested | `realismParams(env,q)` — exposure/sun/bloom/env knobs. |
| `src/sim/route.ts` | **CHG** | pure, tested | Add `NIGHT_CAB` grand route; **keep `WESTFORD_EASTBANK`** (test fixture). No new fields on `Route`. |
| `src/render/quality.ts` | **CHG** | pure, tested | Add `tier` + kill-switches (`shadowsEnabled`/`bloomEnabled`/ribbon/`attitudeScale`). |
| `src/render/terrainRibbon.ts` | **NEW** | impure adapter | Track-following heightfield ribbon, chunked + LOD, zero-alloc updates. |
| `src/render/structures.ts` | **NEW** | impure adapter | Viaduct, tunnel portals/bore, retaining walls, anchored to terrain. |
| `src/render/realism.ts` | **NEW** | impure adapter | ACES, sun+shadow, gated bloom, sky+PMREM, procedural PBR textures. |
| `src/render/scene.ts` | **CHG** | impure adapter | Camera/cab on the centreline frame; wire ribbon/structures/realism; boot `NIGHT_CAB`. |
| `src/render/cab.ts` | **CHG** | impure adapter | Cab rides eased fractional frame attitude (D7); else unchanged. |
| `src/main.ts` | **CHG** | impure shell | Pass extended quality to scene; select `NIGHT_CAB`; still arithmetic-free. |
| `test/centerline.test.ts` | **NEW** | — | O1–O9 (centreline oracles). |
| `test/terrain.test.ts` | **NEW** | — | O3–O7, O10 (terrain/feature/determinism oracles). |
| `test/world.test.ts` | **NEW** | — | O14, O17 (budget + realismParams oracles); REG re-export. |
| `src/sim/physics.ts`, `simulation.ts`, `controls.ts`, `aws.ts`, `train.ts`, `environment.ts` | **UNCHANGED** | pure | Physics keeps using **1D `gradeAt`**; must **not** import `centerline.ts` (R9/O15). `environment.ts` may gain a tiny pure `fogFarFor` helper only if needed — else unchanged. |
| `src/ui/*`, `src/audio/*`, `src/input/*` | **UNCHANGED** | — | No HUD/audio/input change. |
| `package.json` | **CHG** | — | 0.10.0 → 0.11.0. No new dependency. |

---

## 4. Acceptance criteria (numbered oracles O1..O17 = definition of done)

**Pure unit oracles (vitest, analytic where marked):**

- **O1 — frame basis is orthonormal.** For a dense sweep of `s`, `frameAt` returns unit `tangent` and unit `up`, with `|tangent·up| < 1e-6` (right-handed frame). No NaN/Inf anywhere on `[0, length]`.
- **O2 — endpoints & monotonic s.** `frameAt(route,0).position.z ≈ 0`; `position.z` is strictly increasing in `s` (forward never reverses), so chainage→world is a function.
- **O3 — heightAt is the analytic integral of grade (ORACLE).** For a route with constant grade `g` over `[a,b]`, `heightAt(b) − heightAt(a) == g·(b−a)` to 1e-9 (closed form), and over the real `NIGHT_CAB` grades, `heightAt` matches a fine reference sum to < 1e-3 m.
- **O4 — lateralOffsetAt matches the circular-arc oracle (ORACLE).** For a single constant-curvature arc radius `R` over central angle `θ`, the lateral deflection equals `R(1−cosθ)` to 1e-6; heading change equals `θ`.
- **O5 — feature classifier matches the signed difference (ORACLE).** Construct a route+terrain where `d(s)` is known analytically (authored valley/hill terms); `featureAt` returns `VIADUCT` exactly on the valley run, `TUNNEL` exactly on the hill run, `CUTTING`/`EMBANKMENT` per the thresholds, with **no off-by-one at boundaries** (boundaries tested explicitly).
- **O6 — structures cannot self-intersect terrain (ORACLE).** For every `s` in a `VIADUCT` run, `formationHeight(s) > naturalGround(s, 0)` (deck above valley floor); for every `s` in a `TUNNEL` run, `naturalGround(s, 0) > formationHeight(s) + bore clearance` (hill above bore). Asserted across the whole route.
- **O7 — track sits on its formation (ORACLE).** For all `s`, `terrainHeight(route, s, x) == formationHeight(s) + BALLAST_TOP` for `|x| ≤ HALF_FORMATION` (rails never float or sink, R5). The far field `terrainHeight(s, x≫)` equals `naturalGround` to 1e-9.
- **O8 — cant is bounded & smooth.** `|cantAt(s)| ≤ CANT_MAX` for all `s`; cant is C0 with bounded first difference over the ramp (no step) — the motion-sickness clamp is provable (R4).
- **O9 — C1 continuity at every segment join (ORACLE).** At each grade/curvature boundary, the centred finite-difference of `position` and of `(pitch, heading)` is continuous within `tol` across the join (no kink ⇒ no camera snap, R4/R8). Eye-clearance helper: `clampEye(y, terrain, MIN_CLEARANCE)` never returns below `terrain + MIN_CLEARANCE` (R8).
- **O10 — terrain determinism (ORACLE).** `naturalGround(route, s, x)` returns bit-identical values across repeated calls and is independent of call order / wall-clock; a fixed sample lattice hashes to a pinned checksum (run-to-run stable, R3).
- **O11 — G3 determinism guard still passes.** `src/sim/centerline.ts`, `terrain.ts`, `realism.ts`, `route.ts`, `quality.ts` contain **none** of `Date | Math.random | performance.now | setTimeout | setInterval` (the existing `signalling.test.ts` G3 grep over `src/sim/*.ts` covers the new sim files automatically; render/* is exempt and *is* where `dt`/canvas live).
- **O12 — geometry budget bound.** A pure `ribbonVertexCount(opts)` returns the chunk×resolution vertex total; assert `low-tier total < LOW_BUDGET` and `high-tier total < HIGH_BUDGET` (numbers chosen so low-tier is phone-safe). This is the *static* half of R1.
- **O13 — LOD seam continuity (ORACLE).** For two adjacent chunks at *different* LOD, their shared-border samples of `terrainHeight` are equal (welded, no crack); a coarse chunk's border verts sit on the same surface the fine chunk samples (R7). Hysteresis: a chunk at the band edge does not change LOD within `±HYST`.
- **O14 — bundle budget.** After `npm run build`, the gzipped JS bundle is below a pinned ceiling (e.g. **≤ 400 KB gz** incl. three + gated bloom path); **no image asset** (`.png/.jpg/.webp/.ktx/.basis`) is emitted to `dist/` (R2). Asserted by a build-output size check in `world.test.ts` (reads `dist/` if present) **and** by BUILD.
- **O15 — physics independence (ORACLE / REG).** `src/sim/physics.ts` and `simulation.ts` do **not** import `centerline.ts`/`terrain.ts` (static-import grep, like G3); the **existing 164 tests pass unchanged** on `WESTFORD_EASTBANK`; a parity test confirms `step()` output is bit-identical before/after this change for a fixed input sequence (R9).
- **O16 — zero per-frame allocation (review + assert).** `terrainRibbon.update(s)` and the camera-frame block allocate nothing on the hot path: scratch vectors/typed arrays are module-level; a test calls `update` in a loop and asserts the chunk `BufferAttribute` identities are unchanged (buffers rewritten, not replaced) (R10).
- **O17 — realismParams mapping.** `realismParams(env, q)`: `bloomStrength === 0` whenever `q.bloomEnabled === false`; exposure/sun follow time-of-day monotonically (night < dusk < day intensity, reusing the `LIGHTING` ordering); all finite.

**Build & headless smoke (implementer treats as definition-of-done):**

- **BUILD** — `npm run build` (`tsc --noEmit && vite build`) is clean, zero warnings; `dist/` contains no image asset (O14).
- **SMOKE-1 (boots & threads the curve)** — headless screenshot of the default (wet-night, high tier) on `NIGHT_CAB`: zero console/page errors; the rails visibly **curve and rise/fall** with the land (not a dead-straight axis).
- **SMOKE-2 (mobile budget)** — narrow/coarse viewport (e.g. 420×780, forced `low` tier): boots, renders the ribbon, **no shadows/bloom**, steady — and a scripted advance of `chainage` over several seconds shows **no growing heap / no per-frame allocation stall** (proxy for R1/R10; capture two frames, assert no error and bounded draw).
- **SMOKE-3 (set-pieces real)** — screenshots positioned at chapter 4 (**viaduct over the valley** — deck above water, piers reaching the floor) and chapter 6 (**tunnel portal + bore** — head wall on the hillside, dark bore). Verifies R6 visually (the oracle O6 proves it numerically).
- **SMOKE-4 (no sickness / no clip)** — on the viaduct curve at high tier, the horizon tilts only **gently** (eased, fractional cant) and the eye never clips below the deck/terrain; at low/reduced-motion tier the ride is **flat** (attitudeScale 0), matching today's stable horizon (R4/R8).
- **SMOKE-5 (no popping)** — a scripted forward run captures frames across a chunk LOD boundary; no visible terrain seam/pop (R7; O13 proves the math).
- **REG** — the existing **164** tests pass; `tsc` zero warnings; the desktop screenshot of `WESTFORD_EASTBANK` (if retained as a test scene) is unchanged when `κ≡0` (straight-route invariance).

---

## 5. Residual risks

- **Authoring the river/headland by hand is fiddly.** The valley/ridge terms in `naturalGround` must be tuned so `featureAt` actually emits a viaduct/tunnel of pleasing length. Mitigation: O5/O6 are *analytic* against the authored terms, so the data is provably self-consistent even before it looks good; aesthetics are a human screenshot-review pass (SMOKE-3), explicitly flagged.
- **Bloom bundle cost on `high` only.** EffectComposer + UnrealBloomPass add ~50–80 KB; gated so low/mid never load it, but it does grow the high-tier bundle. O14's ceiling is the guard; if breached, drop bloom to a cheap emissive-only glow (the signal halos already prove the look) — a clean fallback, not a redesign.
- **Shadow acne / peter-panning** on the follow-shadow ortho box needs bias tuning — a screenshot-tuning chore, not a design risk. If it fights us on mid tier, shadows degrade to `off` (the kill-switch), never breaking the build.
- **Motion-sickness is subjective.** O8 bounds cant and SMOKE-4 shows a gentle horizon, but the *right* `attitudeScale` on `high` is a feel decision needing human eyes; the safe default is to ship `attitudeScale` low (~0.3) and let a later tweak raise it. Mobile/reduced-motion is provably flat (0).
- **PMREM env-map rebuild cost** on environment-preset change is a one-off hitch (not per-frame); acceptable, and skipped entirely on `low` tier (flat env).
- **Heap growth under long sessions** can't be fully proven headlessly; SMOKE-2 is a proxy. O16 pins the allocation discipline at the buffer-identity level, which is the real lever.

---

## 6. Decision log

- **D1 — One pure centreline is the spine.** `centerlineAt/frameAt` is the single source everything (camera, rails, terrain formation, structures) reads. Tie-break vs. a baked polyline mesh: the analytic curve gives **closed-form oracles** (O3/O4) and zero asset weight. Chosen.
- **D2 — Terrain is *defined from* the formation, not independent.** `terrainHeight = blend(formation, natural)` makes cuttings/embankments/valleys/hills emerge from a single signed difference `d(s)` — so rails can't drift (R5) and structures can't self-intersect (R6). This is the cleanest model that holds in the head. Chosen over an independent heightmap (which would constantly fight the track).
- **D3 — Track-following ribbon, not a world grid.** A 13 km world grid is unshippable on mobile (R1). The ribbon caps geometry to what's near the line, with distance-LOD. Tie-break vs. quadtree-of-the-world: a ribbon is *far* simpler (one parameter `s`) and matches a railway's "you only see near the line" reality. Chosen.
- **D4 — Procedural canvas textures, zero committed image assets.** Keeps the static-host bundle tiny (R2) and dependency-free. Tie-break vs. a small texture atlas: even one atlas adds weight and a fetch; procedural normal maps give PBR relief for free. Chosen.
- **D5 — Realism techniques are all *gated kill-switches*, not feature flags.** ACES (free) always on; shadows/bloom/sky-env scale with the **pure** quality tier. No env vars, no `?flag=`. Tie-break: the brief bans flags/env-vars; the tier is derived from device capability and defaults desktop to "all on". Chosen.
- **D6 — Keep `WESTFORD_EASTBANK`; add `NIGHT_CAB`.** The 6 km line is the physics/signalling **test fixture**; deleting it would churn the 164 tests for no benefit (R9). The app boots on the grand route; tests keep the small one. Chosen over rewriting the fixture.
- **D7 — Cab/eye ride a *clamped, eased, fractional* frame attitude (the OPEN FORK, resolved toward realism-with-a-leash).** The dissent: "stay yaw-only (today), zero sickness risk." The rationale for taking *fractional* pitch/roll instead: a dead-flat camera on a banked viaduct looks wrong and throws away the centrepiece's payoff, but **raw** cant/grade is a sickness hazard. The synthesis — `attitudeScale ∈ [0,1]`, eased via the already-tested `approach()`, **0 on mobile/reduced-motion**, ~0.3–0.4 on high — gives a gentle, *gorgeous* tilt with the horizon barely moving, and it is **provably bounded** (O8) and **provably flat** where it matters for safety (O8 + SMOKE-4 at low tier). Crucially the cab and eye take the *same* fraction, so there's no relative cab-vs-eye sloshing (the worst nausea trigger). This is strictly safer than "full realism" and strictly prettier than "yaw-only", and the safety floor (flat) is a switch away. **Chosen: fractional+eased, default low, off on mobile.**
- **D8 — No `?tier=` override / no debug flags.** Adding a URL tier override would be flag-creep the brief forbids; the tier is a pure function of `matchMedia`/DPR. A developer can edit `quality.ts` locally. Chosen for simplicity.
- **D9 — Physics stays 1D and import-isolated.** `physics.ts`/`simulation.ts` keep using `gradeAt` and must not import the 3D path; O15 greps the imports. The 3D world is *presentation* of the same 1D motion — the train's longitudinal dynamics are unchanged, so all driving/signalling tests hold (R9). Chosen.
- **D10 — Build in safe increments with the switches as the safety net.** Increment order: (1) centreline + oracles (pure, no visual change — straight when κ≡0); (2) camera on the frame (flat attitude first); (3) terrain ribbon (low res, no structures); (4) structures (viaduct/tunnel); (5) realism pass; (6) raise `attitudeScale`/tiers. Each increment is shippable and reversible by a switch, never by a flag. Chosen.
