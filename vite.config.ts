import { defineConfig } from "vitest/config";

// base "./" so a built bundle can be hosted under any subpath (e.g. GitHub Pages).
export default defineConfig({
  base: "./",
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
