// Post-build static gate (HLD §2.6 / O22 / S5). No deps — Node ESM only.
//
// Proves three things about the Vite build output before it ships to a static host
// (GitHub Pages):
//   (a) dist/ exists with an index.html and hashed JS assets.
//   (b) the bloom/composer modules are a LAZY chunk reached only via dynamic
//       import() — NOT folded into the main entry chunk (so the coarse/mobile
//       path that never calls startBloom() never downloads them — S5).
//   (c) any failure exits non-zero with a clear message.
//
// Robustness to Vite's hashed filenames: we never hard-code a hash. We read
// index.html to find the main entry chunk (`<script type="module" src=...>`),
// and we match the lazy chunks by name prefix (`EffectComposer-*.js`,
// `UnrealBloomPass-*.js`).
//
// The matcher caveat (R3 deviation #4): a CORRECT lazy build still mentions the
// bloom symbols in the main chunk — as the dynamic-import dependency map
// (`import("./UnrealBloomPass-<hash>.js")`) and as namespaced call sites
// (`new ns.UnrealBloomPass(...)`). Those PROVE laziness; they are not a fold.
// So we do NOT grep for the bare identifier. We assert instead:
//   - the dedicated chunk FILES exist, and
//   - the main chunk reaches them via a dynamic import("./...Bloom/Composer...js"), and
//   - the main chunk contains NO class DEFINITION of these symbols
//     (`class UnrealBloomPass`/`class EffectComposer ... extends`), which is what
//     a real fold-into-main would produce.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");
const assetsDir = join(distDir, "assets");

function fail(msg) {
  console.error(`check-dist: FAIL — ${msg}`);
  process.exit(1);
}

// (a) dist/ + index.html + hashed assets ------------------------------------
if (!existsSync(distDir)) fail(`dist/ not found at ${distDir} (run vite build first)`);

const indexPath = join(distDir, "index.html");
if (!existsSync(indexPath)) fail(`dist/index.html not found`);
const indexHtml = readFileSync(indexPath, "utf8");

if (!existsSync(assetsDir)) fail(`dist/assets/ not found`);
const assetFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
if (assetFiles.length === 0) fail(`no .js assets in dist/assets/`);

// hashed = name has a Vite content-hash segment, e.g. index-MG-JSH0s.js
const hashed = /-[A-Za-z0-9_-]{6,}\.js$/;
if (!assetFiles.some((f) => hashed.test(f))) {
  fail(`no hashed JS assets in dist/assets/ (found: ${assetFiles.join(", ")})`);
}

// (b) locate the main entry chunk via index.html ----------------------------
// <script type="module" ... src="./assets/index-<hash>.js"></script>
const scriptSrcs = [...indexHtml.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(
  (m) => m[1],
);
const entryRef = scriptSrcs.find((s) => /\.js(\?|#|$)/.test(s));
if (!entryRef) fail(`no <script src=...js> entry found in index.html`);

// resolve the entry ref (e.g. "./assets/index-<hash>.js") to a file in dist/
const entryName = entryRef.replace(/[?#].*$/, "").replace(/^\.?\//, "");
const entryPath = join(distDir, entryName);
if (!existsSync(entryPath)) fail(`entry chunk referenced by index.html not found: ${entryName}`);
const mainChunk = readFileSync(entryPath, "utf8");

// the dedicated lazy chunk files must exist ---------------------------------
const bloomChunk = assetFiles.find((f) => /^UnrealBloomPass-/.test(f));
const composerChunk = assetFiles.find((f) => /^EffectComposer-/.test(f));
if (!bloomChunk) {
  fail(
    `no dedicated UnrealBloomPass-*.js chunk in dist/assets/ — bloom may be folded ` +
      `into the main chunk (S5 would be unfalsifiable). Assets: ${assetFiles.join(", ")}`,
  );
}
if (!composerChunk) {
  fail(
    `no dedicated EffectComposer-*.js chunk in dist/assets/ — composer may be folded ` +
      `into the main chunk. Assets: ${assetFiles.join(", ")}`,
  );
}

// the main chunk must reach them via a dynamic import("./...chunk.js") --------
function importsLazily(prefix) {
  // import("./UnrealBloomPass-<hash>.js") — the dynamic-import dep wiring
  const re = new RegExp(`import\\(\\s*["']\\.\\/${prefix}-[^"']+["']\\s*\\)`);
  return re.test(mainChunk);
}
if (!importsLazily("UnrealBloomPass")) {
  fail(`main chunk (${entryName}) does not dynamically import the UnrealBloomPass chunk`);
}
if (!importsLazily("EffectComposer")) {
  fail(`main chunk (${entryName}) does not dynamically import the EffectComposer chunk`);
}

// the main chunk must NOT contain a class DEFINITION of these symbols ---------
// (a real fold-into-main would emit the class body here). Bare identifiers /
// dep-map strings / namespaced call sites are tolerated (R3 deviation #4).
const foldedDef = /class\s+(UnrealBloomPass|EffectComposer)\b/.exec(mainChunk);
if (foldedDef) {
  fail(
    `main chunk (${entryName}) contains a class definition of ${foldedDef[1]} — ` +
      `bloom/composer appears folded into the main entry, not lazy (R3/S5 defect). ` +
      `Ensure scene.ts reaches the composer ONLY via dynamic import() and uses ` +
      `'import type' for any type-only reference.`,
  );
}

// success -------------------------------------------------------------------
console.log(
  `check-dist: OK — entry=${entryName}; bloom lazy chunks present ` +
    `(${bloomChunk}, ${composerChunk}) and dynamically imported; ` +
    `no bloom/composer class definition folded into the main chunk.`,
);
