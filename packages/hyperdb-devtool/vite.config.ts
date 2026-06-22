import { resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { visualizer } from "rollup-plugin-visualizer";

const shouldAnalyze = process.env.ANALYZE === "true";

export default defineConfig({
  build: {
    lib: {
      entry: {
        react: resolve(__dirname, "src/react.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: [
        "@will-be-done/hyperdb",
        "@will-be-done/hyperdb/drivers/inmemory",
        "@will-be-done/hyperdb/react",
        "@will-be-done/hyperdb/tracing",
        "react",
        "react-dom",
        "react/jsx-runtime",
      ],
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
    optimizeDeps: {
      include: ["react-dom/client"],
    },
    alias: [
      {
        find: "@will-be-done/hyperdb/drivers/inmemory",
        replacement: resolve(
          __dirname,
          "../hyperdb/src/hyperdb/drivers/inmemory/bptree-inmem-driver.ts",
        ),
      },
      {
        find: "@will-be-done/hyperdb/react",
        replacement: resolve(__dirname, "../hyperdb/src/react.ts"),
      },
      {
        find: "@will-be-done/hyperdb/tracing",
        replacement: resolve(
          __dirname,
          "../hyperdb/src/hyperdb/tracing/index.ts",
        ),
      },
      {
        find: "@will-be-done/hyperdb",
        replacement: resolve(__dirname, "../hyperdb/src/index.ts"),
      },
    ],
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
