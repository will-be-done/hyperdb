// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "HyperDB",
      description:
        "A local-first, reactive database for TypeScript with typed schemas, indexed queries, generator-based selectors/actions, and pluggable storage drivers.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/withastro/starlight",
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
          ],
        },
        {
          label: "Database",
          items: [
            { label: "Schemas", slug: "database/schemas" },
            { label: "Indexes", slug: "database/indexes" },
            { label: "Data Types", slug: "database/data-types" },
            { label: "Reading Data", slug: "database/reading-data" },
            {
              label: "Selectors & Reactivity",
              slug: "database/selectors-reactivity",
            },
            { label: "Writing Data", slug: "database/writing-data" },
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
            {
              label: "In-Memory + Persistence",
              slug: "guides/in-memory-persistence",
            },
            { label: "Building a Sync Engine", slug: "guides/sync-engine" },
          ],
        },
      ],
    }),
  ],
});
