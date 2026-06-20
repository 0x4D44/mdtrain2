// Headless visual smoke-driver for The Night Cab. Launches Chromium with
// software WebGL, loads the game, drives it with the real key events, and
// screenshots the canvas so the render can be verified without a human.
//
//   node scripts/drive.mjs <url> <outPrefix> <driveSeconds> [shots]
//
// e.g. node scripts/drive.mjs http://localhost:5173/ shots/local 18 5
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const outPrefix = process.argv[3] ?? "shots/drive";
const driveSeconds = Number(process.argv[4] ?? 16);
const shots = Number(process.argv[5] ?? 4);

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(2500); // let the scene build + first frames render

await page.keyboard.press("h"); // hide the controls panel for a clean shot
await page.keyboard.press("f"); // reverser FORWARD (default is OFF — no traction otherwise)
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("q"); // acknowledge AWS / clear any startup penalty
  await page.waitForTimeout(120);
}
await page.keyboard.press("a"); // brakes off
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("w"); // notch up to full power
  await page.waitForTimeout(150);
}

const stepMs = (driveSeconds * 1000) / shots;
for (let t = 0; t < shots; t++) {
  // tap Q (AWS/DSD ack) and keep brakes released across the interval
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press("q");
    await page.keyboard.press("a");
    await page.waitForTimeout(stepMs / 3);
  }
  await page.screenshot({ path: `${outPrefix}_${t}.png` });
}

console.log("console/page errors:", JSON.stringify(errors.slice(0, 12)));
await browser.close();
