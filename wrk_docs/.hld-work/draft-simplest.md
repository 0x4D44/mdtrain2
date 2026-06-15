# HLD — mdtrain2 World Overhaul "The Night Cab" — SIMPLEST-VIABLE angle

**Status:** DRAFT · Date 2026-06-15 · angle = SIMPLEST-VIABLE · target `package.json` 0.10.0 → 0.11.0
**Provenance:** drafted against current HEAD (Phases 0–5 merged, 164 tests green). The load-bearing seam is a **pure parametric centreline + pure terrain field** carved into `src/sim`, tested by analytic oracles; Three.js terrain meshing, PBR materials, tone-mapping, the sky and the optional bloom are **named impure adapters** verified by build + headless screenshots — exactly the Phase 3–5 pattern.

The line stops being a straight rail painted on a flat green plane. It becomes a **route the land threads around**: the formation climbs onto an embankment over the fields, drops into a cutting whose walls rise past the windows, leaps a river valley on a **viaduct**, runs the coast, and bores a **tunnel** through a headland into the terminus. We get there with the **fewest new modules that can possibly deliver it**: **two** pure sim modules (`centreline`, `terrain`), **one** impure terrain-mesh builder, and **knob additions** to the three pure modules that already exist (`environment`, `quality`, `motion` is untouched). No new npm dependency. Everything else is data and wiring.

---

## 1. Scope & non-goals

### In scope
1. **A real living landscape.** A track-following terrain **ribbon** (heightfield) that the line genuinely threads through: cuttings cut, embankments carry the line above the fields, a river valley is spanned by a viaduct, a headland is bored by a tunnel. The flat `PlaneGeometry` ground and the faked sloped-box "banks" in `scenery.ts` are **deleted**.
2. **A grand multi-chapter route.** A new `NIGHT_CAB` route (≈ **12 km**, 6 stations) whose 1-D profile data (grades, curvatures, speed limits, signals) is authored so that the **pure terrain field** produces each chapter's set-piece. The old 6 km `WESTFORD_EASTBANK` is retired as the live route (kept only as a test fixture if a test still references it; otherwise deleted).
3. **A real lift toward realism, free-first.** `ACESFilmicToneMapping` + exposure (free), an sRGB-correct pipeline, **procedural canvas textures + normal maps** (grass / ballast / rock / water — no committed image assets), a **gradient sky dome** that reads the env sky colour, and — **gated by the quality tier** — **one** shadow-casting sun and an **optional** bloom pass via `three/examples`. Mobile/weak GPUs scale every one of these down through `quality.ts`; nothing breaks if they are all off.
4. **A centreline-framed camera.** The camera position/yaw/pitch/roll come from the pure centreline frame plus the existing LMB look-offset, so the eye banks correctly through curves and over the viaduct.

### Non-goals (ruthless cuts)
- **No 2-D track plan.** The centreline turns in 3-D (it has lateral offset from curvature and height from grade) but the route is still authored as the existing 1-D `Segment` profiles. We do **not** introduce a free 2-D bezier track layout — curvature integrates to a lateral offset, which is all the eye needs.
- **No physics change.** `physics.ts`/`simulation.ts` keep using `gradeAt` on the 1-D chainage. The 3-D centreline is render-only; **physics never imports it** (keeps the sim core pure and the 164 tests untouched).
- **No streaming / chunk manager / quadtree LOD.** The ribbon is a **single** fixed-width strip rebuilt around the camera by **vertex displacement** (no re-allocation), with **distance-based row spacing** baked into the strip. One mesh, zero per-frame allocation. (See D6.)
- **No water simulation, no reflective viaduct puddles, no day/night-driven cloud, no god-rays.** A flat translucent river plane at the valley floor is enough.
- **No new npm dependency.** `three/examples/jsm/*` sub-imports (Sky, EffectComposer, UnrealBloomPass) are **not** new deps (per brief).
- **No feature flags, minimal env vars** (none added). Realism scales by the *pure quality tier*, not by toggles.
- No migration / back-compat (sandbox).

---

## 2. The design

The whole overhaul rests on **two pure functions** and a single rule: *the rail formation is the centreline; the land is the formation blended outward into natural ground; their difference is the scenery.*

```
                 cutting (land > formation)            viaduct (land << formation)
   land  ____                  /‾‾‾\                  ____
        /    \____            /     \            ____/    \         hill → TUNNEL
   ─────┼─────────[formation = centreline.y]──────────────┼─────────  ← the line
        embankment (land < formation)        river valley (deep gap)
```

### 2.1 `src/sim/centreline.ts` (NEW, PURE, TESTED) — the parametric line

The single source of truth for *where the line is in 3-D*. Pure integrals of the existing 1-D profiles — no banned tokens, lives happily under `src/sim`.

```ts
import type { Route } from "./route";

export interface Frame {
  /** World position of the rail head at chainage s (m). */
  x: number; y: number; z: number;
  /** Unit forward tangent (dx,dy,dz)/|.| — drives camera yaw+pitch. */
  tx: number; ty: number; tz: number;
  /** Cant (super-elevation) angle, rad, +ve banks the line into a curve. */
  cant: number;
}

/** Formation height: ∫₀ˢ grade(u) du. Analytic per piecewise-constant segment. */
export function heightAt(route: Route, s: number): number;

/** Lateral offset of the centreline from the straight z-axis (m), from curvature.
 *  A circular arc of radius R bent over arc-length s offsets by R·(1−cos(s/R)).
 *  Sign follows curvature sign; straight segments contribute pure translation
 *  along the running heading. Accumulated piecewise so it is C0 and kink-free. */
export function lateralAt(route: Route, s: number): number;

/** Cant from |curvature| and design speed: cant = clamp(k · v_design² · |1/R|, 0, CANT_MAX). */
export function cantAt(route: Route, s: number): number;

/** The full render frame at chainage s. position = (lateralAt, heightAt, arcZ),
 *  tangent = normalised d/ds of position (closed-form from the same integrals). */
export function frameAt(route: Route, s: number): Frame;
```

**Geometry model (kept deliberately small).** The route runs predominantly along **+Z** as today; curvature steers a *heading* in the X–Z plane. Rather than integrate a full 2-D plan (rejected, D2), we use the **small-curvature offset closed form**: over a curved segment of radius `R = 1/|k|` and entry heading `θ₀`, the centreline sweeps an arc; for the gentle main-line radii here (`R ≥ 250 m`) the lateral excursion `R·(1−cos(Δs/R))` and along-track advance `R·sin(Δs/R)` are exact for a circular arc. We **accumulate** entry position + heading segment-to-segment so the curve is continuous (C0) and the tangent is continuous (no kink) at every boundary — that continuity is an oracle (O3). `z` is the accumulated along-track advance; `x` the accumulated lateral; `y = heightAt`. Because grade and curvature segments are piecewise-constant, every integral is a closed form (line on a straight, `R·sin`/`R·(1−cos)` on an arc) — **no numerical integration, no sampling error, an exact analytic oracle**.

`frameAt` returns one `Frame`; callers (terrain builder, camera) read it. **Zero per-frame allocation:** the camera path calls a variant `frameInto(route, s, out: Frame)` that writes into a reused struct.

### 2.2 `src/sim/terrain.ts` (NEW, PURE, TESTED) — the living-land field

```ts
import type { Route } from "./route";

/** Natural (pre-railway) ground height at a world point, BEFORE the line cut
 *  through it: large rolling landforms (authored per route via control bands)
 *  + seeded value-noise detail. Deterministic; NO Math.random/Date. */
export function naturalGroundAt(route: Route, x: number, z: number): number;

/** The terrain the player sees: blend the rail FORMATION (a flat shelf at the
 *  centreline height, with a ballast shoulder) into the natural ground by |d|,
 *  where d = signed lateral distance from the centreline. */
export function terrainAt(route: Route, x: number, z: number): number;

/** Convenience the builder & set-piece logic share: at chainage s, is the line
 *  in a CUTTING (natural ≫ formation), on an EMBANKMENT (natural ≪ formation),
 *  spanning a VOID (river valley → viaduct) or under a hill (→ tunnel)? */
export type Lineform = "GRADE" | "CUTTING" | "EMBANKMENT" | "VIADUCT" | "TUNNEL";
export function lineformAt(route: Route, s: number): Lineform;
```

**The blend (the heart of it).** For a world point, find the **nearest chainage** `s*` on the centreline and the signed lateral distance `d` to it (cheap: the line is monotone in Z, so `s* ≈ z` corrected by the small lateral offset — one Newton step, closed-form, no search). Then:

```
formation(s)      = centreline.y(s)                       // the flat rail shelf height
shoulder(d)       = formation − BALLAST_DROP · ramp(|d|, SHOULDER_W, SHELF_W)  // ballast falls off the edge
natural           = naturalGroundAt(route, x, z)
blend t           = smoothstep(SHELF_W, BLEND_W, |d|)     // 0 on the shelf → 1 out in the fields
terrainAt         = lerp(shoulder(d), natural, t)
```

- Near the track (`|d| < SHELF_W ≈ 4 m`) the terrain **is** the formation + ballast shoulder — the line always sits on a clean bed.
- Out past `BLEND_W (≈ 60–120 m)` the terrain **is** the natural land.
- In between, the **difference (natural − formation)** does all the storytelling for free:
  - `natural > formation` ⇒ the blend climbs **above** rail level → a **cutting** (walls rise past the windows).
  - `natural < formation` ⇒ the blend falls **below** rail level → an **embankment** (banks fall away; the line floats over the fields).
  - `natural ≪ formation` by more than `VIADUCT_GAP (≈ 18 m)` over a contiguous run ⇒ a **river valley** that the heightfield simply *drops into* — the line stays at formation height, the land plunges; the builder spans it with a **viaduct** (§2.4) and lays a river plane on the valley floor.
  - `natural > formation + TUNNEL_RISE (≈ 12 m)` over a contiguous run ⇒ a **hill the line can't climb** → the builder caps the ribbon and the line **bores a tunnel** (§2.4); inside, the world is the tunnel bore, not the heightfield.

`lineformAt` is just these same thresholds evaluated on the **centreline** (d = 0) so the camera/builder and the set-piece geometry agree. Authoring a chapter's set-piece = shaping `naturalGroundAt` with a few **control bands** (centre, half-width, peak/trough height along chainage) so the valley/hill land exactly where the route data wants it. This is the *only* place new landform data lives.

**`naturalGroundAt`** = sum of (a) a handful of authored **landform bands** (each a smoothstep bump/dip in chainage × a lateral falloff) + (b) seeded **value noise** (a 2-D hash-lattice, bilinear, 2–3 octaves) for rolling texture. The hash is a pure integer mix (the `mulberry32`/`imul` style already in `scenery.ts`), **no `Math.random`, no `Date`** — passes G3.

### 2.3 The grand route — `NIGHT_CAB` in `src/sim/route.ts` (CHG, PURE, TESTED-adjacent)

`route.ts` is unchanged in *shape* — same `Route`/`Segment`/`Signal` types, same `gradeAt`/`curvatureAt`/`speedLimitAt`/`aspectAt`. We add the `NIGHT_CAB` route constant (and the landform-band table it pairs with lives in `terrain.ts`, keyed by chainage so they stay in lock-step). **Length ≈ 12 000 m** — long enough to feel like a journey, short enough to author by hand and to mesh as one ribbon (D6).

| Chapter | Chainage (m) | Station / feature | Lineform | Set-piece |
|---|---|---|---|---|
| 1 City terminus | 0 | **Kingsgate** (depart) | GRADE | Lit platforms, city blocks crowding both sides, OLE masts |
| 2 Suburb | 0 → 2 200 | **Elmwood** @ 1 800 | shallow **CUTTING** 800→1 600 | Brick overbridges, back-garden fences, the walls rise past the cab |
| 3 Countryside climb | 2 200 → 5 000 | **Harburn** @ 4 200 | **EMBANKMENT** 2 600→3 800 | The line lifts onto a bank over open fields; hills on the skyline |
| 4 The viaduct | 5 000 → 6 600 | (no stop) | **VIADUCT** 5 400→6 100 | **River-valley crossing on a multi-arch viaduct** — the signature shot; the land drops ~22 m, river plane below |
| 5 Coast | 6 600 → 9 200 | **Saltmarsh** @ 8 000 | GRADE, gentle curves | Sea plane to one side, a curving formation, distant headland growing ahead |
| 6 Headland tunnel | 9 200 → 10 400 | (no stop) | **TUNNEL** 9 600→10 200 | Bore through the headland: portal, ring-lit bore, emerge into… |
| 7 Sea terminus | 10 400 → 12 000 | **Eastbank** @ 12 000 | falling grade into buffers | Terminus throat, speed steps down, buffer stops |

Authoring rules carry over verbatim: signals are station starters at `board + STARTER_OFFSET`; Kingsgate (origin) and Eastbank (terminus) get none; curvatures stay gentle (`R ≥ 250 m`) so the closed-form offset is exact and motion comfortable. Grades are bounded so adjacent chapters' formation heights line up with the authored valley/hill so the viaduct/tunnel land exactly where chapters 4 and 6 say.

### 2.4 `src/render/terrain.ts` (NEW, impure adapter) — meshing the world

Replaces `scenery.ts`'s `buildHills` + `buildCuttingsAndEmbankments` (those are deleted) and the flat ground in `scene.ts`. Builds, **once**:

1. **The terrain ribbon.** A single `PlaneGeometry`-derived strip, `W` wide (`±RIBBON_HALF`, e.g. ±160 m) and `L` long with `Nrows × Ncols` vertices. Row spacing **densifies near the eye-line and coarsens outward** (distance LOD baked into UVs). Built flat, then **the vertices are displaced every frame by `terrainAt(route, worldX, worldZ)`** as the ribbon is **scrolled to follow the camera** (the strip recentres on the train; only the `position` attribute's Y is rewritten into the *pre-allocated* buffer — zero allocation, matching the rain-scroll pattern already in `scene.ts`). Normals are recomputed cheaply from neighbouring displaced rows (finite difference, in place). Material: PBR `MeshStandardMaterial` with the procedural grass/rock textures (§2.5), `vertexColors` blending grass→rock by slope.
2. **The viaduct** (where `lineformAt === "VIADUCT"`): a parametric multi-arch structure — deck at formation height, piers dropping to the valley floor (`naturalGroundAt` under each pier), arched spans between. A flat translucent **river plane** at the valley trough. Built from instanced piers + arch boxes; one group, placed once.
3. **The tunnel** (where `lineformAt === "TUNNEL"`): portal rings at the entry/exit chainages, a dark bore tube around the line, ring lights. The ribbon is *clipped/lowered* over the tunnel run so the hill reads as solid over the bore.
4. **Ballast bed** along the whole line (a thin strip at `shoulder(d)` height) so the track always has a clean shoulder regardless of the land.

Signature: `buildWorld(scene, route, frameOf, opts: WorldOptions): WorldHandle` where `frameOf = (s)=>Frame` (from centreline), `WorldHandle.update(camChainage)` rewrites the ribbon Y buffer + scrolls it. `WorldOptions` carries the quality knobs (ribbon resolution, shadow on/off — see §2.7).

### 2.5 Realism, free-first (in `src/render/scene.ts`, impure)

Layered so each tier above the free baseline is independently gateable:

- **Free, always on (no perf cost, no deps):**
  - `renderer.outputColorSpace = SRGBColorSpace`, `renderer.toneMapping = ACESFilmicToneMapping`, `renderer.toneMappingExposure = env.exposure`. This alone lifts the whole image (filmic highlight roll-off, correct mid-tones).
  - **Procedural textures**, generated once on a `<canvas>` (the same `CanvasTexture` path the signal glow already uses): a tiling **grass** albedo+normal, **ballast** albedo+normal, **rock** (cutting/tunnel walls), **water**. Tiny bundle, no committed assets. Functions: `makeNoiseTexture(opts)`, `makeNormalFromHeight(heightCanvas)`.
  - A **gradient sky dome**: a large back-face sphere whose vertex colours run from `env.skyColor` at the horizon to a darker zenith — reads the existing env palette, costs one mesh. (We deliberately prefer this over `three/examples` `Sky` for the baseline — D5 — because `Sky` models a *daytime* atmosphere and the project's signature is the wet-night; the gradient dome honours `environment.ts` directly.)
- **Gated by `quality.shadows` (desktop/strong only):**
  - **One** shadow-casting `DirectionalLight` (the existing `moon`, promoted): `castShadow=true`, `PCFSoftShadowMap`, a tight ortho frustum that follows the camera chainage so the viaduct/cuttings throw real shadows. Off entirely on mobile (the existing flat-lit look survives).
- **Gated by `quality.bloomStrength > 0` (desktop/strong only, optional):**
  - `EffectComposer` + `UnrealBloomPass` from `three/examples/jsm/postprocessing/*` (~50–80 KB, code-split). When `bloomStrength === 0` we keep the plain `renderer.render` path (no composer constructed) — so mobile pays nothing and the bundle's bloom chunk is lazy-imported only when needed.
  - An **optional PMREM env map** off the sky dome for PBR reflections on the wet rails/viaduct, also gated (it's a one-time `PMREMGenerator` bake, cheap, but skipped on the lowest tier).

`scene.ts` constructs the composer/shadow map **only if** the quality knob asks for it, so there is exactly one branch per feature and the impure surface stays small.

### 2.6 Camera & cab — the frame (`src/render/scene.ts`, impure)

Today `render()` hard-codes `camera.position.set(EYE_X, 1.9, eyeZ)` and `rotation.set(lookPitch, BASE_YAW+lookYaw, 0)`. New per-frame logic:

```ts
centreline.frameInto(route, view.chainage, FRAME);     // reused struct, no alloc
// Base camera frame from the centreline:
const yaw   = Math.atan2(FRAME.tx, FRAME.tz);          // heading from tangent
const pitch = Math.asin(-FRAME.ty);                    // climb/descent from tangent
const roll  = ROLL_GAIN * FRAME.cant;                  // banking, eased + clamped
// Eye sits at the frame, lifted to eye height along the frame's up:
camera.position.set(FRAME.x + EYE_X_lateral, FRAME.y + EYE_HEIGHT, FRAME.z);
camera.rotation.set(pitch + lookPitch, BASE_YAW + yaw + lookYaw, roll);
cabMount.position.copy(camera.position);
cabMount.rotation.set(CAB_PITCH, BASE_YAW + yaw, CAB_ROLL);   // see fork decision D1
```

**The cab fork (D1) — DECIDED: the cab rides yaw + a *clamped, eased* pitch/roll.** The simplest-viable choice is **not** the bare yaw-only current behaviour (it would look broken on the viaduct — the world banks but the cab stays level, breaking the illusion that the cab is bolted to the train) and **not** full 1:1 frame pitch/roll (motion-sickness + the cab furniture clipping the screen frame on steep grades). Instead the cab and camera share a **single eased, clamped** pitch/roll: `CAB_PITCH = clamp(ease(framePitch), ±PITCH_MAX)`, `CAB_ROLL = clamp(ease(frameCant·ROLL_GAIN), ±ROLL_MAX)` with `ROLL_MAX ≈ 4°`, `PITCH_MAX ≈ 3°`, a first-order ease (the same `approach()` already in `physics.ts`, reused). This gives a *felt* bank through curves and over the viaduct without nausea, and the cab moves with the train as one rigid body (correct). The look-offset (`lookYaw/lookPitch`) still adds on top, unchanged. Because the ease state is a render-local scalar advanced by `dt`, it stays out of `src/sim` (no banned tokens there). **This is the one genuinely debatable decision; it is called out for review (O11 screenshot proves it doesn't induce gross tilt).**

### 2.7 `src/render/quality.ts` (CHG, PURE, TESTED) — the realism dial

Extend `QualitySettings` (today `{pixelRatioCap, rainCount}`) with realism knobs, all derived from the *same* device hints — **no new inputs, no env vars**:

```ts
export interface QualitySettings {
  pixelRatioCap: number; rainCount: number;          // unchanged
  ribbonRes: number;     // terrain vertices along/across (desktop hi, mobile lo)
  shadows: boolean;      // one shadow-casting sun (desktop only)
  bloomStrength: number; // 0 ⇒ no composer (mobile); >0 ⇒ UnrealBloomPass
  envMap: boolean;       // PMREM reflections (desktop only)
}
```

| tier | pixelRatioCap | rainCount | ribbonRes | shadows | bloomStrength | envMap |
|---|---|---|---|---|---|---|
| desktop (default) | 2 | 2400 | hi (e.g. 96×220) | **on** | 0.6 | **on** |
| coarse-pointer (mobile) | ≤1.5 | 900 | lo (e.g. 48×120) | off | 0 | off |
| reducedMotion | (as base) | 0 | (as base coarse/desktop) | (unchanged) | (unchanged) | (unchanged) |

The existing desktop values are preserved exactly (no regression on the three existing `QUAL` oracle expectations — those fields are unchanged; the new fields are *additional*). `reducedMotion` keeps owning rain only. All knobs are pure functions of the three booleans/number already passed in.

### 2.8 `src/sim/environment.ts` (CHG, PURE, TESTED) — realism palette knobs

Add three render-only fields to `EnvironmentParams`, computed purely from `time × weather`:

```ts
  /** ACES exposure: brighter by day, dimmer at night, knocked back in storm. */
  exposure: number;
  /** Sun/moon direction (unit-ish) for the shadow-casting light & sky dome. */
  sunDirX: number; sunDirY: number; sunDirZ: number;
  /** Bloom multiplier (0..1) modulating quality.bloomStrength (wet-night glows most). */
  bloomScale: number;
```

These are pure mappings (lookup tables like the existing `LIGHTING`), so the existing ENV1–ENV6 oracles are untouched and we add ENV7 pinning the new fields. `scene.ts` reads them each frame (exposure → `toneMappingExposure`; sunDir → the directional light + dome; `bloomScale × quality.bloomStrength` → the composer's strength).

### 2.9 What stays pure / untested

- **Pure + tested (new/changed):** `src/sim/centreline.ts`, `src/sim/terrain.ts`, `src/sim/route.ts` (the new data, validated by an authoring-invariant oracle), `src/render/quality.ts` (extended), `src/sim/environment.ts` (extended).
- **Untested impure adapters (named):** `src/render/terrain.ts` (ribbon/viaduct/tunnel meshing), `src/render/scene.ts` (camera frame, tone-mapping, sky dome, shadow map, composer, ground deletion), `src/render/scenery.ts` (trees/people/overbridges now anchored to `terrainAt`; fake banks/hills deleted), `src/render/cab.ts` (no change beyond reading the eased pitch/roll the mount already applies). Verified by build + headless screenshots.
- **Untouched:** `physics.ts`, `simulation.ts`, `controls.ts`, `aws.ts`, `train.ts`, `ui/*`, `audio/*`, `input/*`, `motion.ts`.

---

## 3. File-level impact map

| File | Action | pure/impure | Why |
|---|---|---|---|
| `src/sim/centreline.ts` | **NEW** | pure (tested) | `heightAt`/`lateralAt`/`cantAt`/`frameAt`/`frameInto` — the 3-D line, analytic. |
| `src/sim/terrain.ts` | **NEW** | pure (tested) | `naturalGroundAt`/`terrainAt`/`lineformAt` — the blend field + set-piece classifier + landform bands. |
| `src/sim/route.ts` | **CHG** | pure (tested) | Add `NIGHT_CAB` (12 km, 6 stations, 7 chapters); retire `WESTFORD_EASTBANK` as the live route. Types/lookups unchanged. |
| `src/sim/environment.ts` | **CHG** | pure (tested) | Add `exposure`, `sunDir{X,Y,Z}`, `bloomScale` to `EnvironmentParams`. |
| `src/render/quality.ts` | **CHG** | pure (tested) | Add `ribbonRes`, `shadows`, `bloomStrength`, `envMap` to the tier. |
| `src/render/terrain.ts` | **NEW** | impure | Terrain ribbon (scroll+displace, no alloc), viaduct, tunnel, river/sea planes, ballast bed. |
| `src/render/scene.ts` | **CHG** | impure | Delete flat ground; camera = centreline frame; tone-mapping + sky dome + gated shadow/bloom/PMREM; wire terrain + new env/quality knobs. |
| `src/render/scenery.ts` | **CHG** | impure | Delete `buildHills` + `buildCuttingsAndEmbankments` (terrain owns relief now); anchor trees/people/overbridges to `terrainAt`. |
| `src/render/cab.ts` | **UNCHANGED** | impure | Mount supplies eased pitch/roll; cab furniture unchanged. |
| `src/main.ts` | **CHG** | impure | Use `NIGHT_CAB`; pass extended quality opts; no arithmetic added. |
| `test/world.test.ts` | **NEW** | — | O1–O8 centreline + terrain + route oracles. |
| `test/environment.test.ts` | **CHG** | — | ENV7 new-field oracle. |
| `test/reach.test.ts` | **CHG** | — | QUAL extended-field oracle (existing fields unchanged). |
| `index.html` | **UNCHANGED** | — | No DOM change (sky/terrain are in-scene). |
| `package.json` | **CHG** | — | 0.10.0 → 0.11.0. |
| `src/sim/{physics,simulation,controls,aws,train}.ts`, `src/ui/*`, `src/audio/*`, `src/input/*` | **UNCHANGED** | — | No sim/physics/HUD/audio/input change. |

---

## 4. Acceptance criteria (numbered oracles — definition of done)

**Pure unit oracles (vitest, deterministic):**

- **O1 — height is the grade integral.** `heightAt(route, 0) === 0`; for any chainage `s`, `heightAt(route, s) ≈ Σ grade_i · (segment overlap with [0,s])` to 1e-9 (closed-form reference computed independently in the test). `heightAt` is continuous (C0): no jump > 1e-9 across any segment boundary.
- **O2 — lateral offset matches the circular-arc closed form.** On a single curved segment of radius `R` over arc-length `Δs`, `lateralAt` equals `R·(1−cos(Δs/R))` (sign from curvature) to 1e-9; on a straight segment the lateral offset is constant (heading-only translation). Independent analytic reference.
- **O3 — the frame is kink-free.** Across every segment boundary the tangent `(tx,ty,tz)` is continuous: `‖t(s⁻) − t(s⁺)‖ < 1e-6`. The tangent is unit length (`‖t‖ ≈ 1`) for all sampled `s`. Position is C0 (O1+O2). (This pins "smooth, no kinks at boundaries" from the brief.)
- **O4 — terrain == formation on the shelf.** For `|d| < SHELF_W`, `terrainAt(route, x, z) ≈ formation(s*) − ballastDrop(|d|)` (the land is the rail bed); the difference from `heightAt` is ≤ `BALLAST_DROP`. No NaN/Inf for any sampled `(x,z)` across the whole route.
- **O5 — terrain == natural far out.** For `|d| > BLEND_W`, `terrainAt ≈ naturalGroundAt` to 1e-9 (the blend has fully handed off). Continuous in between: sampling `|d|` across the blend shows no jump > a small ε (monotone smoothstep handoff).
- **O6 — the set-pieces exist where the route says.** `lineformAt` returns `CUTTING` somewhere in chapter 2's authored band, `EMBANKMENT` in chapter 3's, `VIADUCT` across chapter 4's valley (natural−formation < −VIADUCT_GAP for a contiguous run), and `TUNNEL` across chapter 6's headland (natural−formation > TUNNEL_RISE). i.e. the grand route genuinely contains all four reliefs. The valley depth at the viaduct centre ≥ 18 m; the hill height over the tunnel ≥ 12 m.
- **O7 — determinism / no banned tokens (G3 extended).** The existing G3 grep (`Date|Math.random|performance.now|setTimeout|setInterval`) now also scans `centreline.ts` + `terrain.ts` (they live under `src/sim/`, so G3 already covers them) and **passes** — the value-noise hash uses integer mixing only. Additionally: `terrainAt`/`naturalGroundAt` are referentially transparent — same `(route,x,z)` ⇒ bit-identical result across two calls (property test).
- **O8 — route authoring invariants hold for `NIGHT_CAB`.** Signals sorted ascending; each at `protected station board + STARTER_OFFSET`; origin & terminus have no starter; `length === 12000`; stations sorted & within `[0,length]`; curvature radii ≥ 250 m (so O2's closed form is exact and motion is comfortable). `aspectAt`/`nextSignalAhead` behave on the new route exactly as the signalling tests already assert in the abstract.
- **O9 — environment realism palette (ENV7).** `exposure` strictly orders night < dusk < day; `bloomScale` is highest for the wet-night; `sunDir` is unit-ish and points "up" (`sunDirY > 0`); all finite. Existing ENV1–ENV6 unchanged (μ default still pins `wetNight = 0.20`).
- **O10 — quality realism tier (QUAL extended).** Desktop ⇒ `shadows:true, bloomStrength:0.6, envMap:true, ribbonRes` hi; coarse-pointer ⇒ `shadows:false, bloomStrength:0, envMap:false, ribbonRes` lo; all finite, `ribbonRes ≥ 1`. The **existing** `{pixelRatioCap, rainCount}` expectations are byte-for-byte unchanged.

**Build + headless-screenshot oracles (definition-of-done for the impure adapters):**

- **O11 — the world renders, zero console/page errors, each chapter is a real shot.** Headless captures at chainages picked one-per-chapter on `NIGHT_CAB`: (a) **suburb cutting** — walls visibly rise above the cab window line; (b) **embankment** — the land falls away below the formation on both sides; (c) **the viaduct** — the deck carries the line across a visibly deep valley with the river below (the signature shot); (d) **coast** — a sea plane to one side; (e) **tunnel** — portal + dark bore around the line. The camera **banks** through the chapter-2/5 curves and over the viaduct (roll non-zero but `|roll| ≤ ROLL_MAX`, so no gross tilt — proves the D1 fork is comfortable, not broken). Driver still on the left, cab furniture not clipping the screen frame.
- **O12 — desktop realism is visibly lifted but stable.** With shadows+bloom+envMap on: the scene shows the ACES filmic palette, the moon/sun casts a shadow from the viaduct/cutting wall, signal/station emissives bloom. No flat-plane horizon seam (the old ground is gone). Frame completes (a screenshot is produced) — a coarse "doesn't tank" smoke, not a perf benchmark.
- **O13 — mobile/coarse best-effort doesn't break.** A narrow-viewport (coarse-pointer simulated) headless run renders the terrain ribbon at low res with shadows/bloom/envMap **off** and **no composer constructed**; zero errors; the train still drives (touch overlay from Phase 5 unchanged). The bloom chunk is **not** loaded on this path (lazy import gated by `bloomStrength>0`).
- **O14 — regression-free.** The existing **164** tests still pass; `tsc --noEmit` zero warnings; `npm run build` clean; physics outputs for a fixed input sequence on `NIGHT_CAB` are bit-identical to the same sequence's expectations (physics reads only `gradeAt`, so swapping the route changes only the *data*, not the *engine*). No `src/sim` module imports `centreline`/`terrain` from `physics`/`simulation` (an import-graph assertion — keeps the seam clean).

---

## 5. Residual risks

- **R1 — single-ribbon LOD vs a 12 km route (top risk).** A track-following ribbon (±160 m, scrolled + displaced) covers what the eye sees, but distant landforms (skyline hills, the far headland) sit *beyond* the ribbon. **Mitigation:** keep the *distant* silhouette as cheap static far-geometry (a low-poly horizon band coloured by the sky dome) — the ribbon owns only the near/mid field the line threads. If the ribbon's far edge reads as a hard cut, the existing fog (`environment.ts`) already hides it; tune `fogFar` per tier. This is the one place the "simplest" choice (one ribbon) is load-bearing and must be screenshot-checked early (O11/O12).
- **R2 — nearest-chainage `s*` for arbitrary `(x,z)`.** The blend needs `s*` per terrain vertex. The closed-form "monotone in Z + one Newton step" is exact only while curvature stays gentle (R ≥ 250 m, enforced by O8). On a sharp curve it would mis-attribute `d`. **Mitigation:** the authoring invariant caps curvature; if a future route violates it, O8 fails loudly. (We deliberately do *not* build a general nearest-point search — that's the over-engineering we're cutting.)
- **R3 — cab pitch/roll motion comfort (the D1 fork).** Eased+clamped banking is a judgement call; headless can prove `|roll| ≤ ROLL_MAX` (O11) but *comfort* needs human eyes. **Flagged for review.** If it still feels off, the clamp constants are a one-line tune; worst case we fall back to yaw-only (the safe current behaviour) with zero structural change.
- **R4 — bundle growth from bloom/PMREM.** `three/examples` post-processing is ~50–80 KB. **Mitigation:** lazy `import()` gated by `bloomStrength>0` so mobile never downloads it; O13 asserts the chunk isn't on the coarse path.
- **R5 — per-frame vertex displacement cost.** Rewriting the ribbon Y buffer every frame is O(Nrows×Ncols). At desktop res (~21 k verts) this is fine; **mitigation:** `ribbonRes` halves it on mobile, and the scroll only rewrites rows that newly entered the window (a sliding rebuild), keeping it cheap. Still zero *allocation* (reused buffer) — the project's hard rule.
- **R6 — procedural normal maps looking flat/noisy.** Canvas-generated normals are a known-tricky look. **Mitigation:** they're free and gateable; if poor, the PBR base colour + ACES alone already lifts the image, and normals can be tuned without structural change. Screenshot-gated (O12).

---

## 6. Decision log

- **D1 — Cab rides an eased, clamped pitch/roll (not yaw-only, not full 1:1).** *Tie-break of the open fork.* Yaw-only looks broken when the world banks over the viaduct (the cab is supposed to be bolted to the train); full frame-roll risks motion sickness and clips the cab furniture against the screen frame on grade. The eased+clamped middle (≈±4° roll, ±3° pitch, first-order ease via the existing `approach()`) gives a felt bank with no nausea and keeps the cab a rigid body with the train. The ease state is a render-local scalar (no banned tokens in `src/sim`). **Dissent acknowledged:** a reviewer who prioritises absolute safety could pick yaw-only; this is reversible in one line and is the explicit review item (R3/O11).
- **D2 — Curvature → lateral *offset* via closed-form arc, not a 2-D track plan.** The eye needs the line to curve and bank; it does **not** need a free 2-D layout. Integrating the existing piecewise-constant curvature as `R·(1−cos)`/`R·sin` keeps the model a handful of closed forms with an exact analytic oracle (O2), and physics keeps its 1-D chainage untouched. A full 2-D bezier plan is the "on-ramp to nowhere" we refuse to build.
- **D3 — Terrain is a *blend field*, not authored mesh.** `terrainAt = lerp(formation, natural, smoothstep(|d|))` makes cuttings/embankments/valleys/hills *emerge from the difference* between the line and the land — one function, four set-pieces, all testable as pure math (O4–O6). Authoring a chapter = adding a landform band, not modelling geometry. This is the single biggest complexity collapse in the design.
- **D4 — One scrolling ribbon, no chunk/quadtree streaming.** A 12 km route doesn't need a streaming terrain system; a ±160 m strip that follows the camera (displaced from the pure field, fog-hidden at its far edge, with a cheap static horizon band behind) covers everything the cab can see. Rejecting chunks/quadtree LOD removes an entire subsystem we'd otherwise have to test and hold in our heads.
- **D5 — Gradient sky dome for the baseline; `three/examples` `Sky` not adopted.** The project's signature is the wet-night; a dome that reads `environment.ts`'s palette honours that directly and costs one mesh, whereas `Sky` models a daytime Rayleigh atmosphere that fights the night look. (PMREM env map still bakes off the dome for reflections on the strong tier.)
- **D6 — Route length = 12 km, 6 stations, 7 chapters.** Long enough to be a *journey* with a distinct city → suburb → country → viaduct → coast → tunnel → terminus arc; short enough to author the 1-D profiles + landform bands by hand and to mesh as a single ribbon. (The brief asked us to "decide a sane length"; 12 km is the smallest that fits all seven set-pieces without cramming.)
- **D7 — Realism scales by the *pure quality tier*, with zero new env vars / feature flags.** `shadows`/`bloomStrength`/`envMap`/`ribbonRes` are pure functions of the same device hints Phase 5 already reads. Free ACES tone-mapping + procedural textures + sky dome are *always on* (they cost nothing and need no deps); shadows/bloom/PMREM earn their place only on the strong tier and are *constructed only when asked* (composer skipped, bloom chunk lazy-loaded) so mobile pays nothing — satisfying "add them only if they earn their place."
- **D8 — Physics never imports the 3-D path.** `centreline`/`terrain` are render-only; `physics.ts`/`simulation.ts` keep using `gradeAt` on 1-D chainage. This is what keeps the 164 existing tests and the determinism guard untouched, and is asserted by an import-graph oracle (O14). The seam stays pure; the visuals stay downstream.
- **D9 — Delete the fakes outright (sandbox, no back-compat).** `buildHills`/`buildCuttingsAndEmbankments` and the flat ground plane are removed, not kept behind a flag — the real terrain supersedes them and dead code is debt. (Per Arthur's hard limit, this is deletion of *our own* code made obsolete by *our own* change, which is allowed.)
