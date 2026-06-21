// One static, zoomed snapshot of the scene (no driving) for render checks.
//   node scripts/snap.mjs <url> <out> [clip]   clip = "x,y,w,h" in page px
import { chromium } from "playwright";
const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots/snap.png";
const clip = process.argv[4]; // optional "x,y,w,h"
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(2800);
await page.keyboard.press("h"); // hide controls panel
const eCount = Number(process.argv[5] ?? 0); // cycle weather/time-of-day (E) for night
for (let i = 0; i < eCount; i++) {
  await page.keyboard.press("e");
  await page.waitForTimeout(250);
}
await page.waitForTimeout(500);
const opts = { path: out };
if (clip) {
  const [x, y, w, h] = clip.split(",").map(Number);
  opts.clip = { x, y, width: w, height: h };
}
await page.screenshot(opts);
await browser.close();
