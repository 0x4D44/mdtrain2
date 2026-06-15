# HLD — mdtrain2 World Overhaul ("The Night Cab") — **TESTABILITY-FIRST angle**

**Status:** DRAFT · Date 2026-06-15 · angle = TESTABILITY-FIRST (maximize the pure, oracle-backed core; minimize and explicitly name the untested Three.js surface). Target `C:\language\mdtrain2` (Phases 0-5 merged, v0.10.0). `package.json` 0.10.0 → **0.11.0**.

The world is a flat plane the line lies *on*. This overhaul makes the world a thing the line **threads through** — cuttings that cut, embankments that carry, a river valley spanned by a **viaduct**, a hill bored by a **tunnel** — on a longer, multi-chapter **Grand Route**, lit with PBR + tone-mapping + one real sun, all still a static-hostable in-browser build.

The governing instinct of this angle: **the world is geometry, and geometry is math.** Every metre of track position, every terrain height, every prop's resting altitude, every "is this span a viaduct?" decision is a *pure function of route data*, computable and checkable on the Node side with no GPU. We carve the entire spatial model into pure, tested modules under `src/sim`, and leave Three.js as a thin, named, screenshot-verified projector that does nothing but *draw what the pure layer computed*. The render adapters contain **no spatial arithmetic worth testing** — they read centreline frames, terrain samples, and anchor heights and place meshes.

---

## 1. Scope & non-goals

### In scope
- **A pure parametric centreline** (`src/sim/centerline.ts`, NEW, PURE, TESTED): `centerlineAt(route, s) → { x, y, z, tangent, up, cant }`. Height is the analytic integral of grade; lateral offset is the analytic integral of curvature (circular-arc geometry). C0-continuous and kink-free. **This is the prime seam** — every placement in the world derives from it.
- **A pure terrain model** (`src/sim/terrain.ts`, NEW, PURE, TESTED): `terrainHeight(route, z, x)` blends the rail **formation height** (the centreline's y + ballast shoulder near the track) with a deterministic **natural ground** field (seeded value noise) by lateral distance `|x|`. The signed *difference* (natural − formation) is what creates cuttings, embankments, river valleys and hills — and the predicates that decide where a **viaduct** spans and a **tunnel** bores.
- **Pure feature predicates** (in `terrain.ts`): `viaductSpanAt(route, s)`, `tunnelBoreAt(route, s)`, `cuttingDepthAt`, `embankmentHeightAt` — all derived from the formation-vs-natural difference, all pure and oracle-tested.
- **Pure prop anchoring** (`src/sim/anchor.ts`, NEW, PURE, TESTED): `anchorY(route, z, x, clearance)` — an object at lineside `(z, x)` rests at `terrainHeight(route, z, x) + clearance`. One function, used by every scenery class so "things sit on the ground" is a tested property, not a per-builder guess.
- **A pure realism param mapping** (extend `src/sim/environment.ts`, CHG, PURE, TESTED): `EnvironmentParams` gains realism knobs — `exposure` (tone-mapping), `sunDir` (unit vector), `sunColorPbr`, `bloomStrength` — all pure functions of `{time, weather}`. Determinism and monotonicity oracles as for the existing fields.
- **A pure quality/LOD tier** (extend `src/render/quality.ts`, CHG, PURE, TESTED): `QualitySettings` gains `shadowsEnabled`, `bloomStrength` cap, `terrainSegLen` (ribbon longitudinal step), `ribbonHalfWidth`, plus a pure `lodForDistance(d, tier) → detailLevel` selector. All pure, oracle-tested.
- **A pure camera/cab frame** (`src/sim/camera.ts`, NEW, PURE, TESTED): `cameraFrame(route, s, look) → { position, yaw, pitch, roll }` from the centreline tangent/grade/cant plus the existing LMB look offset, with the **cab-roll clamp** baked in as a pure, tested function (see D7).
- **The Grand Route as data** (`src/sim/route.ts`, CHG, data only): a longer multi-chapter line `KINGSCROSS_SEAHAVEN` (city terminus → suburb → countryside → viaduct → coast → tunnel → terminus) with grades/curvatures/speedLimits/signals/stations and **new optional per-route feature bands** (`viaducts[]`, `tunnels[]`, `terrainSeed`) the pure terrain layer reads. `physics.ts` keeps using `gradeAt` only and must not import the 3D path.
- **Render adapters** (`src/render/scene.ts`, `terrain-mesh.ts` NEW, `scenery.ts`, `cab.ts`, CHG, IMPURE, screenshot-verified): build a **track-following terrain ribbon** mesh from `terrainHeight`, place rails/sleepers/props along `centerlineAt`, anchor props with `anchorY`, draw viaduct/tunnel structures where the predicates fire, and apply the realism params (ACES tone-mapping, one shadow-casting sun, optional bloom, procedural textures, sky dome + PMREM env map). **No spatial math here** — pure reads only.

### Non-goals
- **No new npm dependency.** `three/examples/jsm/*` sub-imports (EffectComposer, UnrealBloomPass, Sky) are part of the existing `three@0.183` install, **not** new deps (per brief). Procedural/canvas textures only — **zero committed image assets**.
- No new train *control* or gameplay; no signalling/timetable/scoring change; no audio change.
- No migration/back-compat: the old `WESTFORD_EASTBANK` route may be **replaced** by the Grand Route as the default (dev sandbox). We keep `WESTFORD_EASTBANK` exported only if a test still references it; otherwise it goes.
- No environment variables, no feature flags. Device capability → quality tier is the *only* branch, and it is pure.
- No server, no network — static Pages build, `vite base "./"` unchanged.
- No physically-accurate terrain erosion / hydrology; "natural ground" is cheap seeded value noise tuned to *read* as rolling land.

---

## 2. The design

### 2.0 Architecture in one breath
```
route data (1D bands)
   │
   ├─ physics.ts ──────────────── gradeAt(route,s)            [unchanged 1D path]
   │
   └─ centerline.ts ── centerlineAt(route,s) → {x,y,z,tangent,up,cant}   ← PRIME SEAM
        │
        ├─ terrain.ts ── terrainHeight(route,z,x); viaductSpanAt; tunnelBoreAt
        │      │
        │      └─ anchor.ts ── anchorY(route,z,x,clearance)
        │
        └─ camera.ts ── cameraFrame(route,s,look) → {position,yaw,pitch,roll}

environment.ts ── environmentParams(env) → {…, exposure, sunDir, sunColorPbr, bloomStrength}
quality.ts ────── qualityFor(env) → {…, shadowsEnabled, bloomStrength, terrainSegLen, ribbonHalfWidth}
                  lodForDistance(d, tier) → detailLevel

render/* (IMPURE, screenshot-only): read the above, place/draw meshes. No spatial arithmetic.
```
Everything left of `render/*` is pure, lives under `src/sim` (or `src/render/quality.ts`, already pure), contains **no banned token** (`Date|Math.random|performance.now|setTimeout|setInterval`), and is covered by vitest oracles. The G3 grep guard therefore polices the *entire spatial model* for free.

---

### 2.1 `src/sim/centerline.ts` (NEW, PURE, TESTED) — the prime seam

```ts
export interface Frame {
  x: number; y: number; z: number;          // world position of the rail head centre at chainage s
  tangent: { x: number; y: number; z: number }; // unit forward direction (dz dominant)
  up: { x: number; y: number; z: number };       // unit up after cant roll
  cant: number;                              // superelevation roll angle, rad (banking into curves)
}

/** World position + orienting frame of the track centre at chainage `s` (m). Pure. */
export function centerlineAt(route: Route, s: number): Frame;

/** Formation height = analytic ∫ grade ds from 0 to s, clamped at the ends. Pure. */
export function heightAt(route: Route, s: number): number;

/** Lateral offset of the centreline from the straight datum: analytic ∫∫ curvature. Pure. */
export function lateralOffsetAt(route: Route, s: number): number;

/** Heading (yaw about world-up) of the tangent at s, rad. Pure. */
export function headingAt(route: Route, s: number): number;
```

**Height (the easy, exactly-checkable one).** Grades are piecewise-constant `Segment<number>` already in `route.grades`. `heightAt(s)` is the exact integral:
`heightAt(s) = Σ over segments fully below s of grade·(to−from) + grade_k·(s − from_k)` for the partial segment containing `s`, clamped to `[0, length]`. This is a closed form with an **analytic oracle**: for a route whose only grade is `0.01` over `[0,1000]`, `heightAt(500) === 5.0` exactly; `heightAt'` (finite-diff) === `gradeAt` everywhere off the breakpoints. Because the integrand is piecewise-constant, the integral is **piecewise-linear ⇒ automatically C0** at every breakpoint (left and right limits agree). That is the continuity guarantee, proved by construction and asserted by O3.

**Lateral offset (the curvy one).** Curvatures are piecewise-constant `1/R`. We integrate twice to get the centreline's planar `(x, z)`:
- heading `ψ(s) = ∫₀ˢ κ dσ` (piecewise-linear in s → continuous),
- position `x(s) = ∫₀ˢ sin ψ dσ`, `z(s) = ∫₀ˢ cos ψ dσ`.

Over a single constant-κ arc of radius `R = 1/κ` starting straight, this has the **closed analytic form** of a circular arc: after turning through angle `θ = κ·L`, the lateral excursion is `x = R·(1 − cos θ)` and the along-track advance is `z = R·sin θ` — the exact oracle the brief names. We evaluate segment-by-segment in closed form (no numeric quadrature needed because κ is piecewise-constant: each segment is either a straight line or a circular arc, both closed-form), accumulating the running `(x, z, ψ)` at each breakpoint. Continuity is automatic: each segment starts from the previous segment's exact end pose. **Smoothness (no kink):** `ψ` is continuous across breakpoints (heading carries over), so the tangent direction is continuous — there are no corners even though curvature jumps (a curvature *step* is a kink in the 2nd derivative, not the 1st; the path stays G1). O4 asserts tangent continuity to 1e-6 across every breakpoint.

> **Note on z.** Today the world uses `z = chainage` directly (a straight line). With curvature the true planar `z(s)` is slightly less than `s` (chord < arc). For a demo line with gentle curves the difference is small; we adopt the **honest** `z(s)` from the integral so curves genuinely bend the world. `physics.ts` is unaffected — it integrates *speed* into the scalar `chainage`, never reads `centerlineAt`. The render camera reads `centerlineAt(chainage)` to place the eye, so the eye follows the real bent path. This is the only behavioural coupling and it is one-directional (render depends on sim; sim never depends on render).

**cant.** `cant(s) = clamp(CANT_GAIN · |κ(s)| · v_ref², CANT_MAX)`, signed by turn direction — a pure function of curvature alone (we use a fixed reference speed `v_ref` = line speed at s, from `speedLimitAt`, so cant is a property of the *route*, deterministic, not of live train speed). Oracle O5: zero on straights, nonzero and correctly-signed on arcs, bounded by `CANT_MAX`.

**Purity.** Trig (`Math.sin/cos/sqrt`) is allowed — only `Math.random` is banned. No `Date`, no clock. Lives in `src/sim` so G3 guards it.

---

### 2.2 `src/sim/terrain.ts` (NEW, PURE, TESTED) — the living landscape

```ts
/** Rail formation height at chainage z (the centreline y + ballast shoulder near track). Pure. */
export function formationHeight(route: Route, z: number): number;

/** Deterministic natural ground elevation at world (z, x). Seeded value noise; no Math.random. Pure. */
export function naturalGround(route: Route, z: number, x: number): number;

/** The terrain the world is built from: blend(formation, natural) by |x|. Pure. */
export function terrainHeight(route: Route, z: number, x: number): number;

/** Signed land-minus-formation at the track centre (>0 cutting, <0 embankment). Pure. */
export function reliefAt(route: Route, z: number): number;

/** True where the river valley is deep enough that the line is carried on a viaduct. Pure. */
export function viaductSpanAt(route: Route, s: number): boolean;

/** True where natural ground rises far above the formation so the line is bored as a tunnel. Pure. */
export function tunnelBoreAt(route: Route, s: number): boolean;
```

**The blend (the heart of the terrain).**
```
formation(z) = heightAt(route, projChainage(z))            // the rail top, from the centreline
natural(z,x) = baseProfile(route, z) + valueNoise(seed, z, x)   // rolling land + a carved river valley
w(x)         = smoothstep(0, BLEND_W, |x| − SHOULDER)      // 0 on the track, 1 far out (BLEND_W ≈ 60 m)
terrainHeight(z,x) = lerp( formation(z) + ballastShoulder(|x|), natural(z,x), w(x) )
```
- Near the track (`|x| ≤ SHOULDER`, ≈ 4 m) the terrain **is** the formation plus a small ballast shoulder → the line always sits on its own bed. `w = 0` here exactly.
- Far out (`|x| ≥ SHOULDER + BLEND_W`) the terrain is pure natural land. `w = 1`.
- In between, a `smoothstep` blend → no C1 discontinuity at the track edge (the banks ease in, not step). This is the cutting/embankment geometry: where `natural > formation`, the blend climbs above the formation as you leave the track → **walls of a cutting**; where `natural < formation`, it falls away → **embankment banks**. The *same one function* produces both, governed entirely by the sign of `natural − formation`. No special-case "bank" geometry (the Phase-4 `addBank` hack is deleted).

**`naturalGround` (deterministic, no `Math.random`).** A small **seeded value-noise** function: integer-lattice hash from `route.terrainSeed` + `(floor(z/CELL), floor(x/CELL))`, bilinearly interpolated, summed over 2-3 octaves. The hash is integer bit-mixing (mulberry-style, the same family `scenery.ts` already uses) — **pure, deterministic, banned-token-free** (it lives in `src/sim`, so it MUST avoid `Math.random`; it does, by construction). `baseProfile` adds the deliberate large features keyed off route data: a **river valley** is a smooth negative Gaussian dip centred on each `route.viaducts[].center`; a **hill** is a positive Gaussian bump centred on each `route.tunnels[].center`. So the big set-pieces are *authored* (placed by route data), and the value noise only adds rolling texture between them — fully deterministic and reproducible.

**Feature predicates.**
```
reliefAt(z)        = naturalGround(z, 0) − formationHeight(z)   // signed, at the centre
viaductSpanAt(s)   = reliefAt(z(s)) < −VIADUCT_THRESH            // land far below formation ⇒ span it
tunnelBoreAt(s)    = reliefAt(z(s)) >  TUNNEL_THRESH             // land far above formation ⇒ bore it
```
These are pure thresholds on the same `reliefAt`, giving a single source of truth: the viaduct exists *because* the valley is deep, the tunnel exists *because* the hill is high. Oracle O8 cross-checks: `viaductSpanAt` is true on exactly the authored viaduct chainages and false elsewhere; same for tunnels; the two predicates are never simultaneously true (O9 — disjoint).

**Anchoring (`src/sim/anchor.ts`, NEW, PURE, TESTED).**
```ts
export function anchorY(route: Route, z: number, x: number, clearance: number): number {
  return terrainHeight(route, z, x) + clearance; // a prop's base sits on the ground + its half-height
}
```
Every scenery class (trees, fences, masts, mileposts, buildings, platform people) computes its base Y from `anchorY` at build time. Oracle O7: for any `(z, x, clearance ≥ 0)`, `anchorY − terrainHeight === clearance` exactly, and the resting base is never *below* the terrain — the "things float / sink" class of bug becomes a tested invariant instead of an eyeballed screenshot.

---

### 2.3 `src/sim/environment.ts` (CHG, PURE, TESTED) — realism knobs

`EnvironmentParams` gains:
```ts
exposure: number;      // ACESFilmic toneMappingExposure; brighter by day, dimmer at night
sunDir: { x:number; y:number; z:number }; // unit vector to the sun/moon (for the shadow-casting light + sky)
sunColorPbr: number;   // hex, linear-ish sun colour for PBR (distinct from the existing decorative sunColor)
bloomStrength: number; // 0..~0.8; lamps/sky bloom, higher at night/dusk for the wet glow
```
All are **pure functions of `{time, weather}`** with the same shape as the existing mapping:
- `exposure`: day `1.0`, dusk `0.85`, night `0.6`, each knocked back slightly by storminess. Monotone day > dusk > night (mirrors the existing intensity ordering — O10).
- `sunDir`: a fixed per-`time` azimuth/elevation (day high, dusk low and warm, night low cool moon) returned as a unit vector (O11: `|sunDir| === 1`).
- `bloomStrength`: higher at night/dusk (wet halos read best in the dark), lower by day; gated to 0 when `qualityFor` disables bloom (the *gate* lives in quality.ts; environment provides the *desired* strength).

The existing ENV1-6 oracles stay green (the μ/colour/fog mapping is untouched); the new fields get O10-O12. **ENV4 calibration pin must hold** against whatever the Grand Route's adhesion needs (see D9).

---

### 2.4 `src/render/quality.ts` (CHG, PURE, TESTED) — tiers + LOD

```ts
export interface QualitySettings {
  pixelRatioCap: number;     // unchanged
  rainCount: number;         // unchanged
  shadowsEnabled: boolean;   // NEW: one shadow-casting sun, desktop-only by default
  bloomEnabled: boolean;     // NEW: gate on the EffectComposer/UnrealBloomPass
  terrainSegLen: number;     // NEW: longitudinal step of the terrain ribbon, m (coarser on mobile)
  ribbonHalfWidth: number;   // NEW: half-width of the track-following terrain ribbon, m
  terrainSubdiv: number;     // NEW: lateral subdivisions across the ribbon
}

/** Pure LOD selector: nearer ⇒ more detail. Bands only; deterministic. */
export function lodForDistance(distance: number, tier: QualitySettings): 0 | 1 | 2;
```
- **Desktop** (not coarse, not reduced): shadows on, bloom on, `terrainSegLen` ≈ 8 m, `ribbonHalfWidth` ≈ 180 m, `terrainSubdiv` ≈ 24.
- **Mobile / coarse-pointer:** shadows **off**, bloom **off**, `terrainSegLen` ≈ 20 m, `ribbonHalfWidth` ≈ 110 m, `terrainSubdiv` ≈ 10, pixel-ratio cap ≤ 1.5 (existing). This is the "must not break on mobile" guarantee, expressed as a pure tier and **tested** (O13: every mobile knob ≤ its desktop counterpart; shadows/bloom strictly off on coarse).
- `lodForDistance`: returns 0 (full), 1 (reduced), 2 (billboard/skip) by distance bands scaled by tier — used by the render layer to pick prop detail. Pure, total, monotone non-increasing in distance (O14).

`reducedMotion` keeps overriding `rainCount` to 0 (unchanged). All new fields finite and within documented bounds across the whole device domain (O15, the existing exhaustive-sweep style).

---

### 2.5 `src/sim/camera.ts` (NEW, PURE, TESTED) — the cab/eye frame, and the roll fork resolved

```ts
export interface LookOffset { yaw: number; pitch: number; } // the existing LMB drag accumulators
export interface CamFrame {
  position: { x:number; y:number; z:number };
  yaw: number;   // base heading (from tangent) + look.yaw
  pitch: number; // base pitch (from grade) + look.pitch
  roll: number;  // cab roll (clamped cant), see below
}

/** Pure: where the eye is and how it's oriented at chainage s with the driver's look offset. */
export function cameraFrame(route: Route, s: number, look: LookOffset, eye: EyeOffset): CamFrame;

/** Pure: the clamped, eased cab roll from track cant — the resolved fork (D7). */
export function cabRoll(cant: number): number;
```

**The fork (cab pitch/roll), resolved — D7.** The cab **rides pitch and a *heavily clamped* roll**, not yaw-only.
- **Pitch** from grade is gentle (max grade ~1.5% ⇒ ~0.86° nose attitude) and adds real "climbing the bank / dropping to the coast" feel with negligible sickness risk → **on**, unclamped beyond the physical grade.
- **Roll** from cant is the gorgeous viaduct-banking effect but the sickness risk. We **include it but clamp hard**: `cabRoll(cant) = sign(cant)·min(|cant|, ROLL_CLAMP)` with `ROLL_CLAMP ≈ 3°` (≈ 0.052 rad), well under perceptual-discomfort thresholds, and the cant itself is already bounded by `CANT_MAX`. Because `cabRoll` is **pure and tested** (O16: bounded by `ROLL_CLAMP`; zero on straights; sign matches turn direction; monotone in cant up to the clamp), the comfort guarantee is a *proved* property, not a hope. The driver's LMB look offset adds on top of the base frame exactly as today.
- Rationale: the brief calls banking "gorgeous but motion-sickness risk, needs clamp/ease." The clamp *is* the ease, and making it a pure tested function is precisely this angle's contribution — we get the look *and* a machine-checked safety bound. Yaw-only (the safe default) would throw away the centrepiece feel on the very viaduct that is the route's signature. Dissent noted in D7.

`cameraFrame` composes: `position = centerlineAt(s).{x,y,z} + eyeOffset rotated into the frame`, `yaw = headingAt(s) + look.yaw`, `pitch = atan(grade) + look.pitch`, `roll = cabRoll(cant(s))`. The render layer (scene.ts) sets `camera.position`/`camera.rotation` and `cabMount.rotation` straight from this — **all the trig that used to be inline in `render()` moves into the tested seam.** scene.ts keeps the YXZ order and the `BASE_YAW = π` convention; with the pure frame, `BASE_YAW` folds into `headingAt` (which already faces +Z at s=0 on a straight start).

---

### 2.6 `src/sim/route.ts` (CHG, data) — the Grand Route

A new default route `KINGSCROSS_SEAHAVEN`, length **~14 km**, seven chapters as set-pieces. The existing `Route` interface gains three **optional** fields the terrain layer reads (so `WESTFORD_EASTBANK`, if kept for tests, still type-checks):
```ts
viaducts?: { center: number; halfLen: number; valleyDepth: number }[]; // forces a river valley + span
tunnels?:  { center: number; halfLen: number; hillHeight: number }[];  // forces a hill + bore
terrainSeed?: number;                                                  // value-noise seed (default 1)
```
`gradeAt/curvatureAt/speedLimitAt/aspectAt/nextSignalAhead` are unchanged. `physics.ts` reads `gradeAt` only — **unchanged, and forbidden from importing `centerline.ts`** (O17 guards this by source-grep).

**The seven chapters (chainages, set-pieces):**

| # | Chapter | Chainage (m) | Set-piece & terrain signature |
|---|---|---|---|
| 1 | **Kings Cross (city terminus)** | 0 – 1 800 | Throat of platforms, station roof, dense lineside buildings, OLE; level formation, shallow **cutting** through the city (`natural > formation`). |
| 2 | **Suburb** | 1 800 – 4 200 | Terraced backs, an **overbridge**, a gentle 1.0 % climb out of town; formation rises onto a low **embankment** above back-gardens. |
| 3 | **Countryside** | 4 200 – 7 500 | Open rolling fields (value-noise terrain reads here), tree clumps, sweeping curve (κ = 1/800) — the centreline genuinely **bends**; cant + cab roll first felt here. |
| 4 | **River valley + VIADUCT** | 7 500 – 8 600 | The centrepiece: a deep authored valley (`viaducts: [{center: 8050, halfLen: 320, valleyDepth: 45}]`); `viaductSpanAt` true across it; the line carried on a multi-arch **viaduct** ~45 m above the river. |
| 5 | **Coast** | 8 600 – 11 000 | Falling grade to sea level, a sea plane on one side (`x > +seaEdge` → flat water at y≈0), cliffs the other; wide curve hugging the shore. |
| 6 | **Headland TUNNEL** | 11 000 – 12 400 | Authored hill (`tunnels: [{center: 11700, halfLen: 380, hillHeight: 60}]`); `tunnelBoreAt` true; portal structures + a dark bored section (interior is just fog + portal light — cheap). |
| 7 | **Seahaven (coast terminus)** | 12 400 – 14 000 | Falling into the buffer stops; seaside station, lamps, people; low embankment to the platforms. |

Stations at chapter ends; signals as station starters per the existing `STARTER_OFFSET` rule; grades/curvatures/speedLimits authored to make each chapter's physics read (the climb, the valley dip, the coast fall). **Authoring invariants** (signals ascending, segments tiling `[0, length]` with no gaps/overlaps) are themselves oracle-tested (O18) so the new data can't silently break the lookups.

---

### 2.7 Render adapters (IMPURE, screenshot-verified) — explicitly named, no spatial math

These contain **zero tested logic**; they read the pure layer and draw.

- **`src/render/terrain-mesh.ts` (NEW, impure).** Builds the **track-following terrain ribbon**: for `i` along the route at step `terrainSegLen`, sample `centerlineAt(s)` for the spine and lay a strip of width `2·ribbonHalfWidth` with `terrainSubdiv` lateral verts, each vert's Y = `terrainHeight(route, z, x)`. One `BufferGeometry`, built once, no per-frame allocation. Distance LOD via chunking (coarser strips far ahead) selected by `lodForDistance`. PBR `MeshStandardMaterial` with procedural grass/rock/ballast textures + normal maps (canvas-generated, see below). This is "huge heightfield" mitigation: a ribbon of ~14 km / 8 m × 24 verts ≈ 42 k verts desktop, ~half that mobile — fine.
- **`src/render/scene.ts` (CHG, impure).** (a) Camera/cab placement now reads `cameraFrame` (all inline trig removed). (b) Rails/sleepers placed along `centerlineAt` samples instead of straight `z=chainage` boxes (a swept set of short segments or a tube-ish strip). (c) Realism: `renderer.toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = env.exposure`; one **shadow-casting** `DirectionalLight` (PCFSoftShadowMap) positioned along `env.sunDir`, gated by `quality.shadowsEnabled`; a **sky dome** (`three/examples/jsm/objects/Sky` or a gradient dome) + a **PMREM env map** baked once from the sky for PBR reflections; optional **bloom** via `EffectComposer` + `UnrealBloomPass` gated by `quality.bloomEnabled`, strength = `env.bloomStrength`. (d) Viaduct & tunnel structures drawn where `viaductSpanAt`/`tunnelBoreAt` fire.
- **`src/render/scenery.ts` (CHG, impure).** Delete the fake `addBank` cuttings/embankments (the terrain ribbon now does this for real). Every prop's Y comes from `anchorY(route, z, x, halfHeight)` — props sit on the real terrain. Hills-as-cones deleted (the terrain *is* the hills). Trees/fences/masts/buildings/people keep their instanced one-mesh-per-class structure, re-anchored.
- **`src/render/cab.ts` (CHG, tiny).** `CabView` gains nothing structural; the mount now receives pitch+roll from `cameraFrame` (set in scene.ts). The cab furniture is unchanged.
- **Procedural textures (impure, in a small `src/render/textures.ts`, NEW).** Canvas-2D-generated tileable grass/rock/ballast/water colour + normal maps (value-noise → bump → normal), built once. **No committed image assets** (keeps the bundle tiny and Pages-friendly). Not unit-tested (canvas/Three), screenshot-verified.

**Why this split is the whole point of the angle:** if a tree floats, a bank steps, the viaduct lands in the wrong place, the curve doesn't bend, or the cab over-rolls — **a pure oracle fails on the Node side before any pixel is drawn.** The screenshot gate then only has to answer the one question machines can't: *does it look like a railway threading real country?*

---

## 3. File-level impact map

| File | Action | pure/impure | Why |
|---|---|---|---|
| `src/sim/centerline.ts` | NEW | **pure (tested)** | `centerlineAt/heightAt/lateralOffsetAt/headingAt` — the prime seam; analytic height & arc offset. |
| `src/sim/terrain.ts` | NEW | **pure (tested)** | `terrainHeight` blend, `naturalGround` seeded noise, `reliefAt`, `viaductSpanAt`, `tunnelBoreAt`. |
| `src/sim/anchor.ts` | NEW | **pure (tested)** | `anchorY` — props rest on terrain + clearance. |
| `src/sim/camera.ts` | NEW | **pure (tested)** | `cameraFrame`, `cabRoll` (clamped) — all camera trig leaves the render layer. |
| `src/sim/environment.ts` | CHG | **pure (tested)** | `exposure/sunDir/sunColorPbr/bloomStrength` realism knobs. ENV1-6 unchanged. |
| `src/sim/route.ts` | CHG | **pure (tested)** | `KINGSCROSS_SEAHAVEN` Grand Route + optional `viaducts/tunnels/terrainSeed`. Lookups unchanged. |
| `src/render/quality.ts` | CHG | **pure (tested)** | tier gains shadows/bloom/ribbon knobs + `lodForDistance`. |
| `test/centerline.test.ts` | NEW | test | O1-O6. |
| `test/terrain.test.ts` | NEW | test | O7-O9 + anchor. |
| `test/world.test.ts` | NEW | test | O10-O18 (realism, quality/LOD, camera roll, route invariants, import guard). |
| `src/render/terrain-mesh.ts` | NEW | impure (screenshot) | Track-following terrain ribbon mesh. |
| `src/render/textures.ts` | NEW | impure (screenshot) | Procedural canvas textures + normal maps. |
| `src/render/scene.ts` | CHG | impure (screenshot) | Read `cameraFrame`; sweep rails/sleepers; tone-map/sun/shadows/sky/PMREM/bloom; viaduct/tunnel structures. |
| `src/render/scenery.ts` | CHG | impure (screenshot) | Delete fake banks/cone-hills; anchor all props via `anchorY`. |
| `src/render/cab.ts` | CHG (tiny) | impure (screenshot) | Mount takes pitch+roll from the frame. |
| `src/main.ts` | CHG (tiny) | impure | Use the Grand Route; pass new quality knobs; project realism params; feed `cameraFrame`/look offset. |
| `package.json` | CHG | — | 0.10.0 → 0.11.0. |
| `src/sim/physics.ts`, `simulation.ts`, `controls.ts`, `aws.ts`; `ui/*`, `audio/*` | UNCHANGED | — | No physics/gameplay/HUD/audio change. physics must NOT import centerline (O17). |

---

## 4. Acceptance criteria — numbered oracles (definition of done)

**Pure unit oracles (Node, no GPU) — the bulk of confidence:**

- **O1 (height integral, analytic).** For a route with a single grade `g` over `[0,L]`, `heightAt(s) === g·clamp(s,0,L)` exactly (≤1e-9). Multi-segment: `heightAt` equals the hand-computed piecewise sum at every breakpoint and midpoint.
- **O2 (height ↔ grade, differential).** Central finite difference of `heightAt` equals `gradeAt` to 1e-6 at every point that is ≥ ε from a breakpoint, across the whole route domain (sampled densely).
- **O3 (height continuity, C0).** At every grade breakpoint `b`, `|heightAt(b−δ) − heightAt(b+δ)| → 0` as δ→0 (≤1e-9 at δ=1e-6) — no step in formation height.
- **O4 (tangent continuity, no kink).** At every curvature breakpoint, the unit tangent from `centerlineAt` is continuous: `|tangent(b−δ) − tangent(b+δ)| ≤ 1e-6`. The path is G1 even though κ steps.
- **O5 (lateral offset, arc oracle).** For a single constant-κ arc `R=1/κ` over `[0,L]`, after `θ=κL`, `centerlineAt(L)` matches the closed form `x = R(1−cosθ)`, advance `z = R sinθ` to 1e-6. On straights (κ=0) `x` is constant and `z(s)=s` exactly.
- **O6 (cant).** `cant === 0` on straights; on arcs `0 < |cant| ≤ CANT_MAX`, sign matches turn direction; `cant` is a pure function of route (same input → same output), no clock.
- **O7 (anchor invariant).** For all sampled `(z,x,clearance≥0)`, `anchorY − terrainHeight === clearance` (≤1e-9) and `anchorY ≥ terrainHeight` — nothing floats or sinks.
- **O8 (terrain blend & predicates).** At `|x| ≤ SHOULDER`, `terrainHeight === formation + ballastShoulder` (blend weight 0, ≤1e-9). Far out the blend weight is 1. `viaductSpanAt(s)` is true for every authored viaduct chainage and false ≥ 50 m outside it; `tunnelBoreAt(s)` likewise for tunnels.
- **O9 (features disjoint & deterministic).** `viaductSpanAt(s) && tunnelBoreAt(s)` is **never** true for any sampled s. `naturalGround/terrainHeight` are deterministic: two calls with the same `(route, z, x)` are bit-identical; changing `terrainSeed` changes the field (non-vacuous).
- **O10 (realism monotonicity).** `exposure` and `bloomStrength` are finite and ordered as designed across `time × weather` (e.g. exposure day > dusk > night for fixed weather); all in documented bounds.
- **O11 (sunDir unit).** `|sunDir| === 1` (≤1e-9) for every `{time,weather}`.
- **O12 (realism determinism).** All new `EnvironmentParams` fields are pure functions of `{time,weather}` (same input → identical output) and contain no NaN/Inf across the full domain.
- **O13 (quality tier ordering).** For every device input, coarse-pointer (mobile) yields `shadowsEnabled === false`, `bloomEnabled === false`, and `terrainSegLen ≥`, `ribbonHalfWidth ≤`, `terrainSubdiv ≤` the desktop values — mobile never asks for *more* GPU than desktop.
- **O14 (LOD monotone).** `lodForDistance(d, tier)` is non-decreasing in `d` (more distance ⇒ equal or coarser detail level), total, and finite over `d ∈ [0, 20000]` for every tier.
- **O15 (quality domain sweep).** Existing exhaustive sweep extended: every new `QualitySettings` field finite and within bounds across `coarsePointer × reducedMotion × {DPR: 0,0.5,1,1.5,2,3,4,NaN,Inf}`; `reducedMotion` still forces `rainCount === 0`.
- **O16 (cab roll clamp — comfort bound, proved).** `cabRoll(cant) === 0` when `cant === 0`; `|cabRoll(c)| ≤ ROLL_CLAMP` for all c; sign(`cabRoll(c)`) === sign(c); `cabRoll` monotone in `c` up to the clamp. (This is the machine-checked motion-sickness safety bound.)
- **O17 (sim/render layering guard — source grep).** Extend the G3-style raw-source test: `physics.ts` and `simulation.ts` source text contains no `centerline`/`terrain`/`camera` import — the 3D path never leaks into physics. And the existing **G3 determinism guard passes unchanged** over `src/sim/*.ts` (centerline/terrain/anchor/camera contain no `Date|Math.random|performance.now|setTimeout|setInterval`).
- **O18 (route data invariants).** For `KINGSCROSS_SEAHAVEN`: signals strictly ascending by chainage; `grades/speedLimits/curvatures` segments tile `[0, length]` with no gap/overlap; every station chainage ∈ `[0, length]`; every `viaducts/tunnels` band inside the route. (Pure data validation — catches authoring slips.)

**Build & regression gates:**

- **REG** the existing **164** tests pass unchanged (centerline/terrain/camera are additive; physics untouched). `tsc --noEmit` zero warnings.
- **ENV4** the calibration pin still holds for the *physics adhesion* μ (the Grand Route's default environment leaves the longitudinal physics on the same μ the tests expect — see D9). If the Grand Route changes the default env, ENV4 moves with it intentionally and is re-pinned.
- **BUILD** `npm run build` clean; bundle has **no new image asset**; `three/examples` sub-imports resolve under `base "./"`.

**Headless-screenshot checks (the implementer treats these as DoD; they answer only what oracles can't):**

- **S1** A countryside screenshot shows the line **in a cutting** (walls rising both sides) somewhere it should, and **on an embankment** (banks falling away) elsewhere — real terrain relief, not flat ground.
- **S2** The **viaduct** screenshot shows the line carried on arches high above a river valley (chapter 4), and the **tunnel** screenshot shows a portal with the line entering the headland (chapter 6).
- **S3** A curved-section screenshot shows the track **genuinely bending** (rails curve away), with the cab subtly **banked** into the curve (roll visible but gentle).
- **S4** Realism on: ACES tone-mapping + a real sun casting **shadows** of masts/trees across the formation; a **sky** behind the hills; lamp **bloom** at dusk/night.
- **S5** **Mobile gate** (emulated coarse-pointer): the world still renders with **no console/page errors**, shadows/bloom off, a coarser-but-correct terrain ribbon — "must not break on mobile."
- **S6** Zero console/page errors on desktop; the train still drives (power moves it; HUD aspect updates) along the bent line.

---

## 5. Residual risks

- **R1 — Aesthetic quality isn't machine-checkable.** Oracles prove the world is *geometrically correct* (right place, right height, bends, banks, spans); only a human can confirm it *looks like* a railway threading real country. Flagged for Arthur's review at S1-S4.
- **R2 — Perf on the long route.** A 14 km terrain ribbon + shadows + bloom + PMREM is the top risk. Mitigations are all in the tested tier (O13/O14): ribbon (not full field), distance LOD, mobile gates. Still, frame-rate is a *sanity check*, not an oracle — the implementer must spot-check interactive FPS desktop and mobile-emulated.
- **R3 — Tunnel interior is cheap.** We don't model a real bore; it's fog + portal light. If it reads as "a black hole," upgrade to a short textured tube — but that's a render-only change, no seam impact.
- **R4 — `three/examples` import paths under Vite + `base "./"`.** EffectComposer/Sky are ESM sub-imports of the installed `three`; they should bundle, but if a path breaks the build, fall back to a hand-rolled gradient sky dome and skip bloom (bloom is already gated to 0 on mobile). No new dep either way.
- **R5 — z(s) < chainage on curves.** Adopting honest planar z means the eye's world-z is slightly behind the scalar chainage on curves. Harmless (render-only), but the implementer must drive the camera from `centerlineAt(chainage)`, never assume `z === chainage`. Asserted indirectly by O5.
- **R6 — Cab roll comfort.** O16 bounds the roll to ~3°, but "comfortable" is partly subjective. If even 3° feels much on a long viaduct, `ROLL_CLAMP` is one tested constant to lower (or set to 0 → yaw+pitch only) with the oracle still green. The design *de-risks* the fork rather than betting the farm on it.
- **R7 — Value-noise tuning.** `naturalGround` must read as gentle rolling land, not jagged spikes — a tuning loop on octave count/amplitude. Determinism (O9) is guaranteed; pleasantness is screenshot-tuned.

## 6. Decision log

- **D1 — The world is math; carve it all pure.** Every spatial quantity (centreline, terrain, anchor, camera) is a pure function of route data under `src/sim`, oracle-tested, G3-guarded. Three.js becomes a dumb projector. This is the angle's thesis: maximize tested core, shrink untested surface to "place the meshes the pure layer computed."
- **D2 — One prime seam: `centerlineAt`.** Both height (∫grade, analytic) and lateral offset (∫∫curvature = circular arcs, analytic) are *closed-form* because the inputs are piecewise-constant — so we get exact oracles (O1, O5), not numeric tolerances, and C0/G1 continuity by construction (O3, O4). Numeric quadrature was considered and rejected: closed form is both simpler and exactly testable.
- **D3 — Terrain = blend(formation, natural) by |x|, one function for cuttings *and* embankments.** The sign of `natural − formation` does all the work; no special-case bank geometry. Deletes the Phase-4 `addBank`/cone-hill hacks. The big set-pieces (valley, hill) are *authored* via route bands so viaduct/tunnel placement is data-driven and testable (O8), with value noise only adding texture.
- **D4 — Predicates over flags.** `viaductSpanAt`/`tunnelBoreAt` are pure thresholds on `reliefAt`, not stored booleans — single source of truth (the structure exists *because* the land demands it), and disjoint by O9. No feature flags anywhere (per brief).
- **D5 — Anchoring is a tested invariant, not a per-builder guess.** `anchorY` (O7) turns "things float/sink" from an eyeball-the-screenshot bug class into a proved property. One function, every prop.
- **D6 — Realism params are pure mappings; the *gates* live in quality.** environment.ts says what's *wanted* (exposure/sunDir/bloomStrength); quality.ts says what the *device allows* (shadows/bloom on/off, ribbon detail). Both pure, both tested (O10-O15). The render layer just obeys. No env vars, one device-derived branch.
- **D7 — Cab rides pitch + *clamped* roll (fork resolved toward realism, with a proved safety bound).** Pitch from grade is gentle and on. Roll from cant is included but clamped to ~3° by the **pure tested** `cabRoll` (O16), so we keep the signature viaduct-banking feel *and* a machine-checked comfort bound. **Dissent considered:** yaw-only is safer and is the current behaviour; we reject it because it discards the centrepiece sensation on the route's headline set-piece, and because making the clamp a tested function removes the usual reason to fear roll (unbounded/janky motion). The clamp constant is a single dial (R6) and can be set to 0 to recover yaw+pitch-only without touching the oracle.
- **D8 — Track-following ribbon, not a full heightfield.** A ±~180 m (desktop) / ±~110 m (mobile) ribbon with distance LOD keeps a 14 km route's geometry tractable. The ribbon dimensions are *quality-tier* outputs (O13), so "mobile must not break" is a tested ordering, not a hope.
- **D9 — Re-pin ENV4 for the Grand Route, don't break physics tests.** The default environment's μ must keep the longitudinal-physics tests green. Either keep the default env identical (μ unchanged) or, if the Grand Route warrants a new default, move ENV4's pinned value with it in the same commit. The physics core is otherwise *untouched* and forbidden from importing the 3D path (O17).
- **D10 — Replace the route, don't keep two.** Dev sandbox: `KINGSCROSS_SEAHAVEN` becomes the default; `WESTFORD_EASTBANK` is retained only if a test still needs it, else deleted. No back-compat shim. New per-route fields are optional so any retained route type-checks.
- **D11 — `three/examples` sub-imports are not a new dep; procedural textures only.** EffectComposer/UnrealBloomPass/Sky ship inside `three@0.183`; canvas-generated textures keep the bundle asset-free and Pages-friendly. If an example path won't bundle (R4), fall back to a gradient sky dome and skip bloom — no new dependency, no approval needed.
- **D12 — Source-grep layering guard (O17) extends the existing G3 pattern.** The same raw-source vitest technique that bans wall-clock tokens also bans `physics.ts` importing the render-only 3D path, keeping the 1D physics seam clean and the determinism guard intact for the new pure modules.
