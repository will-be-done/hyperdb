import { resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
        devtool: resolve(__dirname, "src/devtool/index.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "sql.js",
        "wa-sqlite",
        "wa-sqlite/dist/wa-sqlite-async.mjs",
        "wa-sqlite/dist/wa-sqlite-async.wasm?url",
        "wa-sqlite/src/examples/MemoryAsyncVFS.js",
      ],
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: [
            "src/hyperdb/drivers/idb/**/*.browser.test.ts",
            "src/hyperdb/runtime/db.test.ts",
            "src/hyperdb/runtime/utf-sort.test.ts",
          ],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
