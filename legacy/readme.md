# UK EMU Cab Simulator

## Overview
This WebGL driving vignette lets you operate a British electric multiple unit inside a fully 3D cab. Everything lives in `index.html`, which combines the HUD, scenery, physics, and audio using Three.js. Your goal is to carry passengers from Westford to Eastbank, keep to the working timetable, and avoid safety violations while enjoying the ambient railway soundscape.

## Route & Objectives
You begin at Westford with doors open and the brake applied. The line calls at Riverside, City Centre, Victoria Street, and terminates at Eastbank. Each station has a STOP board aligned with the driver's position; stop with your cab within +/-2 metres, open the doors, dwell for 8 seconds, then depart when interlock is green.

## Controls & Cab Systems
- `LMB`: capture pointer for free-look; `Esc` recentres the view.
- `W` / `S`: notch the traction controller up or down (0-1 range).
- `A` / `D`: increase or ease the service brake.
- `Space`: open or close doors when stopped correctly; auto-close after dwell if you forget.
- `Q`: acknowledge AWS when warned by a yellow magnet or red signal.
- `R`: recover after a derailment or SPAD once the train is at rest.
The HUD shows speed, current limit, signal ahead, timetable timings, brake/throttle percentages, score, and door state. The AWS and DOORS lamps on the fascia mirror the HUD data.

## Scoring, AWS, and Incidents
Staying within posted limits and arriving within +/-30 seconds earns positive score. Excess speed, late departures, or missing a stop subtract points. Failing to cancel AWS within 3 seconds triggers an emergency brake, and passing a red starter signal flags a SPAD with a heavy penalty. Taking high-speed curves can derail the unit; acknowledge incidents with `R` to regain control.

## Running Locally
Chrome, Edge, and Firefox treat `file://` pages as insecure, so pointer lock, audio, and procedural textures will fail if you double-click `index.html`. Serve the project instead:

1. From the repo root run `npx serve .` (or `python -m http.server 8080`).
2. Open the printed `http://localhost:PORT/` link in your browser.
3. Click the canvas once to grant pointer lock and start audio.

For quick tweaks, edit `index.html` (e.g. adjust the Three.js CDN near line 80) and refresh the localhost tab.

## Deploying
- Commit and push the repository to GitHub.
- In GitHub -> Settings -> Pages, point the deployment at your branch (use the repository root).
- GitHub serves the build over HTTPS at `https://<username>.github.io/<repo>/`, so pointer lock and audio work without extra configuration.
