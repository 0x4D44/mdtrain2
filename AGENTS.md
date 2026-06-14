# Repository Guidelines

## Project Structure & Module Organization
`index.html` in the repository root contains markup, styles, and simulation logic for the UK EMU Cab Simulator. It embeds HUD components, tooltip overlays, and a large `<script>` block using Three.js. When extending the project, group new features inside self-documenting IIFEs (`(function () { ... })();`) already used for track, signals, and platforms so behaviours stay isolated. If you add large assets (textures, audio), place them under a new `assets/` directory and reference with relative paths to keep Git history readable.

## Build, Test, and Development Commands
This project is static; no build step is required. For local previews, serve the root directory to avoid CORS issues, e.g. `npx serve .` or `python -m http.server 8080`. Use `npm install serve --global` only if you need a persistent binary. When adjusting dependencies such as Three.js, update the CDN URL near the top of `index.html` and smoke-test in multiple browsers.

## Coding Style & Naming Conventions
JavaScript follows a modular, functional style with `const` for immutables and camelCase identifiers (`updateSignalAspect`, `makeBallastTex`). Maintain two-space indentation inside the `<script>` block and align chained operations vertically for readability. Prefer descriptive helper names over comments, and document tricky maths with short inline comments. Keep CSS scoped via IDs (`#hud`, `#overlay`) to avoid collisions.

## Testing Guidelines
Automated tests are not yet configured. Perform manual verification after each change: load the sim, confirm HUD updates while driving, validate signal aspects, and ensure frame rate stays stable (>50fps) via DevTools. When adjusting physics or assets, capture before/after screenshots or screen recordings and attach them to the pull request. If you introduce automated tests later, colocate them under `tests/` and run them in CI before merging.

## Commit & Pull Request Guidelines
Current history uses generic messages (`Updated files`), so adopt imperative, scoped titles such as `feat: refine signal aspect timing`. Reference issue IDs in the body when applicable, and list notable user-facing changes. Pull requests should include a concise summary, manual test notes (e.g. "Windows 11 + Chrome 127"), and any regression risks. Request review before merging, and avoid bundling unrelated changes in the same PR.
