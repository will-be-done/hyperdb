# HyperDB Docs Summary

Use this file as a map when changing `packages/hyperdb`,
`packages/hyperdb-devtool`, or the docs themselves. If an API, runtime behavior,
driver, React hook, tracing/devtool feature, or package entry point changes,
check the matching docs below and also check the root `README.md`.

## Top-level docs package files

- `astro.config.mjs`: Astro Starlight site configuration. Defines the site URL,
  title, description, logo, GitHub social link, custom CSS, and the sidebar
  structure for all documentation pages. Update this when adding, removing, or
  moving doc pages.
- `src/content.config.ts`: Starlight content collection setup using
  `docsLoader()` and `docsSchema()`. Update only if the docs content model or
  loader changes.
- `package.json`: Package metadata and docs scripts (`dev`, `start`, `build`,
  `preview`, `astro`) plus Astro/Starlight dependencies.
- `tsconfig.json`: TypeScript configuration for the docs site.
- `src/styles/theme.css`: Custom Starlight theme. Covers brand colors, font
  stack, dark/light theme tokens, hero layout, splash screenshot styling, cards,
  link cards, and general content polish.
- `public/favicon.svg`: Browser favicon.
- `src/assets/logo.svg`: HyperDB logo used by the Starlight config.
- `src/assets/hero-code.png`: Homepage hero screenshot showing schema,
  selector, and action code.
- `src/assets/devtool-call-tree.png`: Devtool screenshot used by the "Why
  HyperDB?" page.

## Homepage

- `src/content/docs/index.mdx`: Splash homepage. Contains the main value
  proposition, GitHub and "Get started" hero actions, hero code screenshot,
  "Why HyperDB" overview, feature cards for typed schemas, indexed queries,
  reactivity, runtime portability, JS selectors/actions, immutable data, React
  and devtools, plus "Start here" link cards.

## Get Started

- `src/content/docs/start/introduction.md`: High-level product introduction.
  Explains what HyperDB is, the shared frontend/backend data layer, Convex
  inspiration, main capabilities, use cases, current server storage limits,
  installation commands, package entry points, and next-step links.
- `src/content/docs/start/why.md`: Motivation and positioning. Covers the
  data-structure problem, notification problem, backend problem, synchronous
  frontend behavior, why browser SQLite is not the default answer, IndexedDB and
  in-memory persistence reasoning, observable query traces, JS selectors/actions,
  and a Redux/MobX/HyperDB comparison table.
- `src/content/docs/start/how-it-works.md`: Core mental model. Explains tables,
  generator commands, selectors, actions, the `DB` runtime, `SubscribableDB`,
  sync vs. async execution helpers, how reads become reactive, and links to
  schemas, data types, reading/writing, runtime, and drivers pages.
- `src/content/docs/start/quickstart.md`: End-to-end task app walkthrough.
  Covers install commands, defining a table, creating shared selector/action
  builders, writing a selector and action, creating an in-memory
  `SubscribableDB`, reading/writing outside React, using React hooks, adding the
  devtool, and where to go next.

## Database

- `src/content/docs/database/schemas.md`: Schema and validator reference.
  Covers `defineTable`, required string `id`, built-in `byId`, `ExtractSchema`,
  validators from `v`, standalone validators and `Infer`, tagged-union tables,
  index declarations, indexable column rules, the `undefined` storage rule, and
  type helper references.
- `src/content/docs/database/data-types.md`: Storable and indexable value
  reference. Lists supported validators and TypeScript types, composite
  validator helpers, binary data behavior, indexable values, `v.any()` rules,
  `undefined` handling, and date/time modeling guidance.
- `src/content/docs/database/reading-data.md`: Selector and query-builder
  guide. Covers selector object fields, `selectFrom`, immutable query builders,
  `where` comparisons, OR queries with `or(...)` or arrays, ordering, limits,
  many-row results, `first()` and `firstOr()`, composing selectors, and
  `select`/`selectAsync`.
- `src/content/docs/database/indexes.md`: Index behavior and valid query
  shapes. Covers declaring B-tree and hash indexes, built-in `byId`, equality,
  range, ordering, composite-key support, indexable value rules, equality-prefix
  and trailing-range rules, query-builder validation errors, and index ordering.
- `src/content/docs/database/selectors-reactivity.md`: Reactive selector cache.
  Covers range tracking, cached selectors, `initCachedSelector`, garbage
  collection, selector memoization controls (`root` and `selfChild`),
  subscriptions, revisions, and practical guidance for writing selectors that
  invalidate precisely.
- `src/content/docs/database/writing-data.md`: Actions and mutations. Covers
  defining actions, `insert`, `upsert`, `deleteRows`, dispatching with
  `syncDispatch`/`asyncDispatch`, why selectors cannot write, transaction
  behavior and rollback, and bulk write guidance.

## Runtime

- `src/content/docs/runtime/db.md`: Runtime API guide. Covers `DB` construction
  and options, `SubscribableDB` revisions/subscriptions/lifecycle hooks,
  `HybridDB` primary/cache behavior and async trade-offs, command execution
  helpers, transactions, traits, `withTraits`, and `getCurrentTraits`.
- `src/content/docs/runtime/drivers.md`: Storage driver guide. Covers choosing
  between in-memory, SQLite, async SQLite, and IndexedDB drivers; sync vs. async
  helper requirements; in-memory setup; SQLite adapter interfaces and storage
  codec; SQL.js, wa-sqlite, and backend native SQLite recipes; IndexedDB setup;
  and practical sync/async usage rules.

## Integrations

- `src/content/docs/integrations/react.md`: React integration guide. Covers
  `DBProvider`, `useDB`, `useSyncSelector`, `useAsyncSelector`, `useDispatch`,
  `useAsyncDispatch`, `useSelect`, `useAsyncSelect`, selector options, default
  values, `enabled`, the React Query-style async selector result, and the full
  hook reference table.
- `src/content/docs/integrations/devtools.md`: Devtool and tracing guide. Covers
  adding `HyperDBDevtools`, devtool tabs and trace inspection, component props,
  embedded panel option, trace contents, cache-hit traces, `HybridDB` source
  labels, per-DB tracers, global default tracers, factory trace options, and
  `skipTrace`.

## Guides

- `src/content/docs/guides/in-memory-persistence.md`: Local persistence guide.
  Shows a synchronous in-memory UI database mirrored to IndexedDB. Covers the
  two-tier shape, full-scan B-tree indexes for hydration, creating both stores,
  hydrating memory from persistent storage, the hybrid-mode note, subscribing to
  changes, coalescing and persisting ops in order, wiring startup, caveats, and
  links to sync-engine next steps.
- `src/content/docs/guides/sync-engine.md`: WIP sync design page. Describes
  planned sync primitives, change tracking, lifecycle hooks, remote changeset
  merge, two-tier persistence, cross-tab syncing, server-as-peer behavior, and
  links to the current Will Be Done implementation references.

## Update checklist for agents

- Schema, validator, type helper, table, or index changes: check
  `database/schemas.md`, `database/data-types.md`, `database/indexes.md`,
  `start/quickstart.md`, and the root `README.md`.
- Query builder or selector API changes: check `database/reading-data.md`,
  `database/selectors-reactivity.md`, `start/how-it-works.md`, React docs if
  hooks are affected, and the root `README.md`.
- Action, mutation, transaction, hook, trait, or dispatch changes: check
  `database/writing-data.md`, `runtime/db.md`, guides that use hooks/persistence,
  and the root `README.md`.
- Driver, storage codec, sync/async, `HybridDB`, IndexedDB, or SQLite changes:
  check `runtime/drivers.md`, `runtime/db.md`, `start/introduction.md`,
  `start/why.md`, persistence/sync guides, and the root `README.md`.
- React integration changes: check `integrations/react.md`, `start/quickstart.md`,
  homepage feature cards if positioning changes, and the root `README.md`.
- Devtool or tracing changes: check `integrations/devtools.md`, `start/why.md`,
  homepage feature cards, screenshots/assets if UI changed, and the root
  `README.md`.
- New docs pages, renamed pages, or changed navigation: update
  `astro.config.mjs` sidebar and this summary.
