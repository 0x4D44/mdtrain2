import { defineConfig } from "@playwright/test";

// Night-visual screenshot harness for The Night Cab. It drives the REAL rendered
// game (Vite dev server) through the keyboard and captures night-time stills of
// the lineside set-pieces (lit facades, signal heads, celestial layer, truss
// bridge, traffic) so each visual slice has a reliable, repeatable gate.
//
// Two robustness fixes over the old ad-hoc snap scripts:
//   1. The runner owns the browser lifecycle, so a crashed shot can never leave an
//      orphaned chromium process behind (the resource-exhaustion failure mode).
//   2. WebGL via SwiftShader (software GL through ANGLE) so headless chromium gets
//      a GL context with no real GPU.
// The key-timing fix (hold each key across a frame so the edge is read before
// main.ts clears it) lives in the spec.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 120_000, // a single SwiftShader composite/readback of the night scene is ~25s
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
