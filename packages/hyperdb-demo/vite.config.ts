import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";

const hyperdbRoot = resolve(__dirname, "../hyperdb");
const hyperdbDevtoolRoot = resolve(__dirname, "../hyperdb-devtool");

// https://vite.dev/config/
export default defineConfig({
  build: {
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: [
      "@will-be-done/hyperdb",
      "@will-be-done/hyperdb/react",
      "@will-be-done/hyperdb/tracing",
      "@will-be-done/hyperdb/drivers/inmemory",
      "@will-be-done/hyperdb/drivers/sqlite",
      "@will-be-done/hyperdb/drivers/idb",
      "@will-be-done/hyperdb-devtool/react",
    ],
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@will-be-done\/hyperdb\/drivers\/inmemory$/,
        replacement: resolve(
          hyperdbRoot,
          "src/hyperdb/drivers/inmemory/bptree-inmem-driver.ts",
        ),
      },
      {
        find: /^@will-be-done\/hyperdb\/drivers\/sqlite$/,
        replacement: resolve(
          hyperdbRoot,
          "src/hyperdb/drivers/sqlite/index.ts",
        ),
      },
      {
        find: /^@will-be-done\/hyperdb\/drivers\/idb$/,
        replacement: resolve(
          hyperdbRoot,
          "src/hyperdb/drivers/idb/idb-driver.ts",
        ),
      },
      {
        find: /^@will-be-done\/hyperdb\/tracing$/,
        replacement: resolve(hyperdbRoot, "src/hyperdb/tracing/index.ts"),
      },
      {
        find: /^@will-be-done\/hyperdb\/react$/,
        replacement: resolve(hyperdbRoot, "src/react.ts"),
      },
      {
        find: /^@will-be-done\/hyperdb$/,
        replacement: resolve(hyperdbRoot, "src/index.ts"),
      },
      {
        find: /^@will-be-done\/hyperdb-devtool\/react$/,
        replacement: resolve(hyperdbDevtoolRoot, "src/react.ts"),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    fs: {
      allow: [__dirname, hyperdbRoot, hyperdbDevtoolRoot],
    },
    sourcemapIgnoreList: false,
  },
});
