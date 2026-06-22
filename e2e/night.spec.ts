import { test, expect, type Page } from "@playwright/test";

// Night-visual gate: load the real game at a set-piece chainage (?s=), cycle to
// the signature wet-night, optionally drive, and capture a full-page still. Each
// shot also asserts the page raised NO console/page errors — that is the real
// pass/fail; the screenshot is a human-review artifact.
//
// KEY-TIMING (the fix that makes this reliable): the game's keyboard source adds a
// code on keydown and main.ts drains the edge set every rAF frame, then clears it.
// A bare press() (keydown+keyup back-to-back) can have its keyup delete the edge
// BEFORE any frame reads it — the press is silently lost (this is why the old
// ad-hoc scripts' `e`/`f` "didn't register"). `tap()` holds the key down across a
// few frames so a frame always observes the edge, then releases it.

const SCREENS = "e2e/screenshots";

/** Wait for `n` real animation frames to execute in the page (frame-rate
 *  independent — SwiftShader's rAF runs far slower than 60 fps headless). */
async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((res) => {
        let i = 0;
        const step = (): void => {
          if (++i >= count) res();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** Press a key so the per-frame edge reader always sees it (see header). Holds the
 *  key down across ≥2 real frames before releasing, so the game's frame loop reads
 *  the edge BEFORE main.ts clears it — regardless of the headless frame rate. */
async function tap(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await frames(page, 2);
  await page.keyboard.up(key);
  await frames(page, 1);
}

/** Full-page capture: skips the element stability-wait that the perpetual rAF
 *  loop would otherwise stall on, and never fails the run on capture flakiness. */
async function shot(page: Page, path: string): Promise<void> {
  try {
    await page.screenshot({
      path,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
      timeout: 30_000,
    });
  } catch (e) {
    console.error(`shot failed for ${path}:`, (e as Error).message);
  }
}

// Env ring (cycled by KeyE from the default): 0 day/rain · 1 dusk/rain ·
// 2 night/rain · 3 day/clear. `setEnv(n)` presses E n times to land on entry n.
async function setEnv(page: Page, presses: number): Promise<void> {
  for (let i = 0; i < presses; i++) await tap(page, "KeyE");
}

/** Drive away from a stand: reverser forward, acknowledge, brakes off, power up,
 *  then hold for `seconds` re-acking AWS/DSD so the penalty brake never bites. */
async function drive(page: Page, seconds: number): Promise<void> {
  await tap(page, "KeyF"); // reverser FORWARD
  await tap(page, "KeyQ"); // acknowledge any startup AWS
  for (let i = 0; i < 4; i++) await tap(page, "KeyA"); // brakes fully off
  for (let i = 0; i < 4; i++) await tap(page, "KeyW"); // notch up to full power
  const steps = Math.max(1, Math.round(seconds / 0.4));
  for (let i = 0; i < steps; i++) {
    await page.keyboard.down("KeyQ"); // keep DSD/AWS acked
    await page.waitForTimeout(300);
    await page.keyboard.up("KeyQ");
    await page.waitForTimeout(100);
  }
}

/** Drag the driver's head (LMB) to look around: dy<0 looks up, dx>0 looks right. */
async function lookAround(page: Page, dx: number, dy: number): Promise<void> {
  const cx = 640;
  const cy = 400;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await frames(page, 2);
}

interface Shot {
  name: string;
  s: number; // ?s= seed chainage (frames a set-piece without driving there)
  drive?: number; // seconds to drive after seeding (0/undefined = static)
  look?: { dx: number; dy: number }; // optional head turn before the capture
  env?: number; // env-ring entry (E-presses): 0 day/rain·1 dusk·2 night·3 day/clear. Default 2.
}

// Set-pieces along KINGSGATE_SEAHAVEN. Signals sit at 2120 / 5920 / 9920 and face
// the train, so seeding ~25 m short frames the head. Buildings cluster 0–1800
// (Kingsgate) and ~2000 (Ashcombe); overbridges at 1200/3000/4000/6600.
const SHOTS: Shot[] = [
  { name: "01-kingsgate-skyline", s: 350 },
  { name: "02-signal-ashcombe", s: 2095 },
  { name: "03-truss-bridge", s: 3982 },
  { name: "04-open-country", s: 4300 },
  { name: "05-signal-wealdham", s: 5895 },
  { name: "06-viaduct", s: 7950 },
  { name: "07-signal-brinemouth", s: 9895 },
  { name: "08-drive-kingsgate", s: 60, drive: 6 },
  { name: "09-moon", s: 4300, look: { dx: 0, dy: -45 } }, // tilt up to frame the hero moon (right pane)
  { name: "10-traffic", s: 4250, look: { dx: -150, dy: 25 } }, // look to the roadside traffic
  // Daylight (clear) hero scenes — realism is mostly a daytime concern (env=3).
  { name: "day-01-kingsgate", s: 350, env: 3 },
  { name: "day-02-signal-ashcombe", s: 2095, env: 3 },
  { name: "day-03-truss-bridge", s: 3982, env: 3 },
  { name: "day-04-open-country", s: 4300, env: 3 },
  { name: "day-05-viaduct", s: 7950, env: 3 },
  { name: "day-06-drive-kingsgate", s: 60, drive: 6, env: 3 },
  // Dusk approach (env=1) — the golden-hour transition.
  { name: "dusk-01-country", s: 4300, env: 1 },
];

for (const sh of SHOTS) {
  test(`visual shot: ${sh.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`[console] ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

    await page.goto(`/?s=${sh.s}`, { waitUntil: "domcontentloaded" });

    // Three.js must have created a WebGL canvas inside #app.
    await expect(page.locator("#app canvas")).toHaveCount(1);
    await page.waitForTimeout(2500); // scene build + first frames

    // Focus the canvas (also satisfies the audio gesture gate) before keys.
    await page.locator("#app").click({ position: { x: 640, y: 400 } });

    await tap(page, "KeyH"); // hide the help panel (shown by default)
    await setEnv(page, sh.env ?? 2); // default: the wet-night
    if (sh.drive && sh.drive > 0) await drive(page, sh.drive);
    if (sh.look) await lookAround(page, sh.look.dx, sh.look.dy);
    await page.waitForTimeout(400);

    await shot(page, `${SCREENS}/${sh.name}.png`);

    expect(errors, `console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });
}
