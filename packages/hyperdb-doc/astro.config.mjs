// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://hyperdb.will-be-done.app",
  redirects: {
    "/database/selectors-reactivity": "/database/reading-data",
    "/database/writing-data": "/database/actions",
  },
  integrations: [
    starlight({
      title: "HyperDB",
      description:
        "A local-first, reactive database for TypeScript with typed schemas, indexed queries, generator-based selectors/actions, and pluggable storage drivers.",
      logo: {
        src: "./src/assets/logo.svg",
        alt: "HyperDB",
      },
      customCss: ["./src/styles/theme.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/will-be-done/hyperdb",
        },
      ],
      sidebar: [
        {
          label: "Get Started",
          items: [
            { label: "Introduction", slug: "start/introduction" },
            { label: "Why HyperDB?", slug: "start/why" },
            { label: "How HyperDB Works", slug: "start/how-it-works" },
            { label: "Quickstart", slug: "start/quickstart" },
            { label: "LLM Cheat Sheet", slug: "start/llm-cheat-sheet" },
          ],
        },
        {
          label: "Database",
          items: [
            { label: "Schemas", slug: "database/schemas" },
            { label: "Indexes", slug: "database/indexes" },
            { label: "Data Types", slug: "database/data-types" },
            { label: "Selectors", slug: "database/selectors" },
            { label: "Reading Data", slug: "database/reading-data" },
            { label: "Actions", slug: "database/actions" },
          ],
        },
        {
          label: "Runtime",
          items: [
            { label: "The DB Runtime", slug: "runtime/db" },
            { label: "Storage Drivers", slug: "runtime/drivers" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "React", slug: "integrations/react" },
            { label: "Devtools & Tracing", slug: "integrations/devtools" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Building a Sync Engine", slug: "guides/sync-engine" },
          ],
        },
      ],
    }),
  ],
});
