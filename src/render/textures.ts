// src/render/textures.ts — IMPURE procedural texture layer (HLD §2.6 (e) + D23).
//
// Canvas-2D albedo + normal maps and a tiny equirect env gradient. NO committed
// image assets. Everything here is built ONCE in createTextureSet() and reused
// for the life of the scene; only the env map is rebuilt/disposed on env change
// (see makeEnvEquirect / disposeEnvEquirect). This module is NOT under the G3
// banned-token set, so Math.random / DOM / Canvas are permitted — but it is
// effectively deterministic (a fixed integer hash, no clock) so screenshots are
// stable and no flicker occurs if a texture is ever rebuilt.
//
// COLOUR-SPACE PINS (D23):
//   - albedo / emissive / env canvas textures => THREE.SRGBColorSpace
//   - normal / roughness DATA textures        => THREE.NoColorSpace
// Tiled textures set wrapS/wrapT = RepeatWrapping; all set needsUpdate = true.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Deterministic value noise (integer hash, bilinear, octaves). Pure-ish: no
// clock, no Math.random, so a rebuild is byte-identical and screenshots stable.
// ---------------------------------------------------------------------------

/** mulberry-style 2-D integer hash → [0,1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 362437;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise sampled on an integer lattice of period `cells`. */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  // Wrap lattice coords so the canvas tiles seamlessly at `cells`.
  const x0 = ((ix % cells) + cells) % cells;
  const y0 = ((iy % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed);
  const v11 = hash2(x1, y1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/** Multi-octave fractal noise → [0,1], tiling at `baseCells`. */
function fbm(
  x: number,
  y: number,
  baseCells: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let cells = baseCells;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, cells, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    cells *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function newCanvas(size: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Headless / no-2D-context fallback: still return a usable (blank) buffer.
    const img = new ImageData(size, size);
    return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D, img };
  }
  const img = ctx.createImageData(size, size);
  return { canvas, ctx, img };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Finalise an albedo CanvasTexture (sRGB, tiled). */
function albedoTexture(
  canvas: HTMLCanvasElement,
  repeat: number,
  anisotropy: number,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Finalise a normal/data CanvasTexture (NoColorSpace, tiled). */
function dataTexture(
  canvas: HTMLCanvasElement,
  repeat: number,
  anisotropy: number,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Albedo + normal generation from a height field
// ---------------------------------------------------------------------------

/** RGB triple, 0..255. */
type RGB = readonly [number, number, number];

/**
 * Build a tileable albedo canvas. `colourAt(h, n)` maps a height/macro value
 * `h ∈ [0,1]` and a fine detail value `n ∈ [0,1]` to an RGB. The height field
 * itself is shared with the normal-map builder so albedo and relief agree.
 */
function buildAlbedoCanvas(
  size: number,
  height: Float32Array,
  detail: Float32Array,
  colourAt: (h: number, n: number) => RGB,
): HTMLCanvasElement {
  const { canvas, ctx, img } = newCanvas(size);
  const data = img.data;
  for (let i = 0; i < size * size; i++) {
    const h = height[i] ?? 0;
    const n = detail[i] ?? 0;
    const [r, g, b] = colourAt(h, n);
    const o = i * 4;
    data[o] = clamp255(r);
    data[o + 1] = clamp255(g);
    data[o + 2] = clamp255(b);
    data[o + 3] = 255;
  }
  if (ctx && typeof ctx.putImageData === "function") {
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/**
 * Derive a tangent-space normal map from a tileable height field via central
 * differences. `strength` scales the slope (bigger = bumpier). Encoded
 * +Z-up: rgb = (nx,ny,nz)*0.5+0.5, so nz≈1 at flat → (128,128,255).
 */
function buildNormalCanvas(
  size: number,
  height: Float32Array,
  strength: number,
): HTMLCanvasElement {
  const { canvas, ctx, img } = newCanvas(size);
  const data = img.data;
  const at = (x: number, y: number): number => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return height[yi * size + xi] ?? 0;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      // tangent normal = normalize(-dx, -dy, 1) (note OpenGL +Y; we keep +Y up)
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const o = (y * size + x) * 4;
      data[o] = clamp255((nx / len) * 127.5 + 127.5);
      data[o + 1] = clamp255((ny / len) * 127.5 + 127.5);
      data[o + 2] = clamp255((nz / len) * 127.5 + 127.5);
      data[o + 3] = 255;
    }
  }
  if (ctx && typeof ctx.putImageData === "function") {
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/** Sample a tileable height + fine-detail field once, shared by albedo+normal. */
function sampleFields(
  size: number,
  macroCells: number,
  macroOct: number,
  detailCells: number,
  detailOct: number,
  seed: number,
): { height: Float32Array; detail: Float32Array } {
  const height = new Float32Array(size * size);
  const detail = new Float32Array(size * size);
  const sm = macroCells / size;
  const sd = detailCells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = fbm(x * sm, y * sm, macroCells, macroOct, seed);
      detail[i] = fbm(x * sd, y * sd, detailCells, detailOct, seed + 9973);
    }
  }
  return { height, detail };
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// ---------------------------------------------------------------------------
// One PBR material's worth of maps
// ---------------------------------------------------------------------------

/** Albedo (sRGB) + normal (NoColorSpace) pair for a PBR surface. */
export interface MaterialMaps {
  /** Base-colour map. colorSpace = SRGBColorSpace, RepeatWrapping. */
  albedo: THREE.CanvasTexture;
  /** Tangent-space normal map. colorSpace = NoColorSpace, RepeatWrapping. */
  normal: THREE.CanvasTexture;
}

/** The full procedural texture set (built ONCE; reused for the scene's life). */
export interface TextureSet {
  /** Grass + earth ground (the terrain ribbon between set-pieces). */
  ground: MaterialMaps;
  /** Track ballast — greyer, coarser stone. */
  ballast: MaterialMaps;
  /** Masonry / concrete — viaduct piers & abutments, tunnel portals, station. */
  masonry: MaterialMaps;
  /** Rail / metal — subtle brushed steel. */
  rail: MaterialMaps;
  /** Dispose every texture in the set (call on scene teardown). */
  dispose(): void;
}

function buildGround(size: number, repeat: number, aniso: number): MaterialMaps {
  // Patchy grass with earthy lows; gentle macro relief, fine blade detail.
  const { height, detail } = sampleFields(size, 4, 4, 16, 3, 1311);
  const earth: RGB = [86, 66, 40];
  const grassDark: RGB = [48, 70, 32];
  const grassLight: RGB = [96, 122, 56];
  const albedo = buildAlbedoCanvas(size, height, detail, (h, n) => {
    // Low patches → earth; high → grass; detail breaks up the green.
    const base = mix(grassDark, grassLight, n);
    const withEarth = mix(earth, base, smooth(Math.min(1, h * 1.3)));
    return withEarth;
  });
  // Relief from both macro lumps and blade detail.
  const relief = new Float32Array(size * size);
  for (let i = 0; i < relief.length; i++) {
    relief[i] = (height[i] ?? 0) * 0.7 + (detail[i] ?? 0) * 0.3;
  }
  const normal = buildNormalCanvas(size, relief, 3.0);
  return {
    albedo: albedoTexture(albedo, repeat, aniso),
    normal: dataTexture(normal, repeat, aniso),
  };
}

function buildBallast(size: number, repeat: number, aniso: number): MaterialMaps {
  // Coarse grey crushed stone: strong high-frequency detail, low macro drift.
  const { height, detail } = sampleFields(size, 8, 2, 32, 4, 5101);
  const dark: RGB = [60, 58, 56];
  const light: RGB = [140, 136, 130];
  const albedo = buildAlbedoCanvas(size, height, detail, (_h, n) => {
    const t = smooth(n);
    return mix(dark, light, t);
  });
  // Sharp stone relief from the high-frequency detail field.
  const normal = buildNormalCanvas(size, detail, 5.0);
  return {
    albedo: albedoTexture(albedo, repeat, aniso),
    normal: dataTexture(normal, repeat, aniso),
  };
}

function buildMasonry(size: number, repeat: number, aniso: number): MaterialMaps {
  // Concrete/stone: low fine grain on a mottled grey, faint coursing lines.
  const { height, detail } = sampleFields(size, 6, 3, 24, 2, 7321);
  const base: RGB = [150, 146, 138];
  const stain: RGB = [110, 104, 96];
  const relief = new Float32Array(size * size);
  const albedo = buildAlbedoCanvas(size, height, detail, (h, n) => {
    const c = mix(stain, base, smooth(h * 0.6 + n * 0.4));
    return c;
  });
  // Horizontal coursing every ~1/6 of the tile, plus fine grain.
  for (let y = 0; y < size; y++) {
    const course = Math.abs(((y / size) * 6) % 1 - 0.5) < 0.04 ? 0.0 : 1.0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      relief[i] = (detail[i] ?? 0) * 0.5 + course * 0.5;
    }
  }
  const normal = buildNormalCanvas(size, relief, 2.0);
  return {
    albedo: albedoTexture(albedo, repeat, aniso),
    normal: dataTexture(normal, repeat, aniso),
  };
}

function buildRail(size: number, repeat: number, aniso: number): MaterialMaps {
  // Subtle brushed steel: nearly uniform grey, faint vertical streaks.
  const { height, detail } = sampleFields(size, 2, 2, 48, 2, 211);
  const dark: RGB = [96, 98, 104];
  const light: RGB = [150, 152, 158];
  const relief = new Float32Array(size * size);
  const albedo = buildAlbedoCanvas(size, height, detail, (_h, n) => {
    const t = smooth(n * 0.6 + 0.2);
    return mix(dark, light, t);
  });
  // Faint lengthwise brushing → mostly flat normal.
  for (let i = 0; i < relief.length; i++) {
    relief[i] = (detail[i] ?? 0) * 0.25;
  }
  const normal = buildNormalCanvas(size, relief, 0.8);
  return {
    albedo: albedoTexture(albedo, repeat, aniso),
    normal: dataTexture(normal, repeat, aniso),
  };
}

/** Lit-window building facade maps (HLD §2.A). An albedo with a faint window
 *  grid (tinted per-instance by `buildBuildings`) PLUS a matching emissive map
 *  with ~half the windows lit warm. At night the low env exposure lets the
 *  existing bloom turn the emissive windows into a lit skyline; by day the high
 *  exposure washes them out so the facade reads as ordinary masonry (AC-A).
 *  Built once; both maps sRGB-pinned per D23. One shared map per DL1 (instancing).
 *  `seed` lets `quality.ts` request a few variants later (3–4 InstancedMeshes). */
export function buildFacade(
  anisotropy = 4,
  seed = 0x9e3779b9,
): { albedo: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  // local deterministic RNG (build-once; no Math.random in the frame loop, G3)
  let t = seed >>> 0;
  const rnd = (): number => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const warm = ["#ffd9a0", "#ffcf86", "#ffe6c4", "#cfe0ff", "#fff4d6", "#ffb870"];
  const W = 128, H = 256;
  const ac = document.createElement("canvas"); ac.width = W; ac.height = H;
  const a = ac.getContext("2d") as CanvasRenderingContext2D;
  const ec = document.createElement("canvas"); ec.width = W; ec.height = H;
  const e = ec.getContext("2d") as CanvasRenderingContext2D;
  // Mid-grey masonry base so the per-instance tint reads; black emissive base.
  a.fillStyle = "rgb(120,122,128)"; a.fillRect(0, 0, W, H);
  e.fillStyle = "#000"; e.fillRect(0, 0, W, H);
  const cols = 5, rows = 13, padX = 10, padY = 10;
  const cw = (W - padX * 2) / cols, ch = (H - padY * 2) / rows;
  const ww = cw * 0.62, wh = ch * 0.6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = padX + c * cw + (cw - ww) / 2;
      const wy = padY + r * ch + (ch - wh) / 2;
      a.fillStyle = "#3a3c42"; a.fillRect(wx, wy, ww, wh); // dark pane in the albedo
      if (rnd() < 0.5) {
        const col = warm[Math.floor(rnd() * warm.length)] as string;
        e.fillStyle = col; e.fillRect(wx, wy, ww, wh); // lit window -> emissive
        a.globalAlpha = 0.4; a.fillStyle = col; a.fillRect(wx, wy, ww, wh); a.globalAlpha = 1;
      }
    }
  }
  return { albedo: albedoTexture(ac, 1, anisotropy), emissive: albedoTexture(ec, 1, anisotropy) };
}

/**
 * Build the full procedural texture set ONCE. `anisotropy` should be the
 * renderer's capability cap (`renderer.capabilities.getMaxAnisotropy()`); pass
 * 1 if unknown. Every texture is tiled (RepeatWrapping) and colour-space-pinned
 * per D23. Call `set.dispose()` on scene teardown.
 */
export function createTextureSet(anisotropy = 1): TextureSet {
  const aniso = Math.max(1, anisotropy | 0);
  const ground = buildGround(256, 1, aniso);
  const ballast = buildBallast(128, 1, aniso);
  const masonry = buildMasonry(256, 1, aniso);
  const rail = buildRail(64, 1, aniso);
  const all: MaterialMaps[] = [ground, ballast, masonry, rail];
  return {
    ground,
    ballast,
    masonry,
    rail,
    dispose(): void {
      for (const m of all) {
        m.albedo.dispose();
        m.normal.dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tiny equirect env map (IBL ambient + wet-rail sheen) — D23, §2.6 (e)
// ---------------------------------------------------------------------------

const ENV_W = 16;
const ENV_H = 16;

function hexToRgb(hex: number): RGB {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/**
 * Build a tiny 16×16 equirect env texture: a vertical gradient from a darkened
 * zenith sky (top) through the horizon to the ground colour (bottom). Cheap IBL
 * for `scene.environment` — gives `envMapIntensity` meaning (wet-rail sheen).
 *
 * Returns a THREE.Texture with:
 *   - mapping    = EquirectangularReflectionMapping (so PMREM treats it as env)
 *   - colorSpace = SRGBColorSpace (it is a colour, not data — D23)
 *   - needsUpdate = true
 *
 * The texture is DISPOSABLE: the caller must dispose the previous env texture
 * (disposeEnvEquirect, or tex.dispose()) BEFORE assigning a new one on env
 * change — the only env-driven rebuild allowed (HLD §2.6 lifecycle).
 */
export function makeEnvEquirect(
  skyColorHex: number,
  groundColorHex: number,
): THREE.Texture {
  const sky = hexToRgb(skyColorHex);
  const ground = hexToRgb(groundColorHex);
  // Zenith slightly darker than the supplied sky; horizon a bright blend.
  const zenith: RGB = [sky[0] * 0.72, sky[1] * 0.76, sky[2] * 0.85];
  const horizon: RGB = mix(sky, [255, 255, 255], 0.18);
  // A raw RGBA buffer is the natural fit for a 16×16 procedural gradient and
  // needs no working 2-D canvas context (robust under headless render too).
  const data = new Uint8Array(ENV_W * ENV_H * 4);
  fillEnv(data, zenith, horizon, ground);
  const tex = new THREE.DataTexture(data, ENV_W, ENV_H, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Top→bottom vertical gradient: zenith → horizon (mid) → ground. */
function fillEnv(
  data: Uint8Array,
  zenith: RGB,
  horizon: RGB,
  ground: RGB,
): void {
  for (let y = 0; y < ENV_H; y++) {
    const v = y / (ENV_H - 1); // 0 = top (zenith), 1 = bottom (ground)
    let col: RGB;
    if (v < 0.5) {
      col = mix(zenith, horizon, smooth(v / 0.5));
    } else {
      col = mix(horizon, ground, smooth((v - 0.5) / 0.5));
    }
    for (let x = 0; x < ENV_W; x++) {
      const o = (y * ENV_W + x) * 4;
      data[o] = clamp255(col[0]);
      data[o + 1] = clamp255(col[1]);
      data[o + 2] = clamp255(col[2]);
      data[o + 3] = 255;
    }
  }
}

/**
 * Dispose an env texture previously returned by `makeEnvEquirect`. Call this on
 * the OLD texture before assigning the new one on environment change (the only
 * permitted env-driven GPU rebuild — HLD §2.6 lifecycle). Null-safe.
 */
export function disposeEnvEquirect(tex: THREE.Texture | null | undefined): void {
  if (tex) tex.dispose();
}

// ---------------------------------------------------------------------------
// Round raindrop sprite (HLD §3F / #9) — a soft circular alpha drop so the rain
// PointsMaterial renders ROUND, not square. Radial-gradient precedent is
// scene.ts makeGlowTexture; built ONCE and reused for the scene's life.
// ---------------------------------------------------------------------------

/**
 * Build a small round raindrop alpha sprite for the rain `PointsMaterial.map`:
 * a soft radial gradient, bright (white, opaque) at the centre fading to fully
 * transparent at the edge, on an otherwise transparent square. The drop's tint
 * comes from the material's `color`; this map only shapes the alpha so the
 * screen-aligned point sprite reads as a round drop rather than a square.
 *
 * colorSpace = SRGBColorSpace per this module's convention for alpha/colour
 * sprites (D23 — same pin as emissive/glow canvas textures).
 */
export function makeRainDropTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
