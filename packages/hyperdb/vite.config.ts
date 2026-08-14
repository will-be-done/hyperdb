import { resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { visualizer } from "rollup-plugin-visualizer";

const shouldAnalyze = process.env.ANALYZE === "true";

export default defineConfig({
  define: {
    "process.env.NODE_DEBUG_NATIVE": "false",
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
        tracing: resolve(__dirname, "src/hyperdb/tracing/index.ts"),
        "drivers/inmemory": resolve(
          __dirname,
          "src/hyperdb/drivers/inmemory/bptree-inmem-driver.ts",
        ),
        "drivers/sqlite": resolve(
          __dirname,
          "src/hyperdb/drivers/sqlite/index.ts",
        ),
        "drivers/idb": resolve(
          __dirname,
          "src/hyperdb/drivers/idb/idb-driver.ts",
        ),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: ["react", "react-dom"],
    },
  },
  plugins: shouldAnalyze
    ? [
        visualizer({
          brotliSize: true,
          filename: "dist/bundle-analysis.html",
          gzipSize: true,
          open: false,
          template: "treemap",
        }),
      ]
    : [],
  test: {
    name: "browser",
    testTimeout: 120_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts", "e2e/**"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
