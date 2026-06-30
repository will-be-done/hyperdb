---
title: Introduction
description: What HyperDB is, the problems it solves, and when to use it.
sidebar:
  order: 1
---

HyperDB is a universal database for TypeScript. It gives you typed schemas,
indexed queries, generator-based selectors and actions, pluggable storage
drivers, HybridDB caching, React hooks, and an in-app devtool.

The defining idea is a shared data layer for the frontend and backend. Your
schema, selectors, and actions are written once and can run in the browser (over
in-memory B+trees, IndexedDB, or WebAssembly SQLite) _and_ on the server (over
native SQLite). Only the storage driver differs per environment.

For durable frontend apps, the main runtime shape is `HybridDB`: a persistent
primary store such as IndexedDB or async SQLite, plus an in-memory B-tree cache
for hot ranges. React reads that hybrid runtime with `useAsyncSelector`, keeping
cached data visible while missing ranges load from persistence, and writes with
`useAsyncDispatch` so both tiers commit together.

It was inspired by [Convex](https://www.convex.dev/): you model your data with
validators, read it with functions instead of raw SQL, and let the runtime keep
your reads reactive. HyperDB takes that ergonomic model and makes it usable on
both the client and server.

## What you get

- Typed schemas: `defineTable` + the `v` validator library describe the
  shape of each row and its indexes. Row types, query columns, and index columns
  are all checked by TypeScript.
- Indexed queries: a fluent, type-safe query builder (`selectFrom`) reads
  through B-tree and hash indexes with equality, range bounds, ordering, and
  limits. Every table is backed by a real B+tree, so inserting into a sorted
  collection stays `O(log n)` instead of the `O(n)` you pay rebuilding or
  shifting an array.
- Selectors & actions: reads and writes are expressed as generator
  functions that _describe_ what to do. The runtime executes them, which makes
  the same code work synchronously against pure in-memory storage or
  asynchronously against durable stores such as IndexedDB and SQLite.
- Hybrid persistence: `HybridDB` checks an in-memory cache first, falls through
  to the persistent primary store only for missing index ranges, then records
  coverage so repeated reads stay fast. You can preload whole tables or specific
  selectors before a route renders.
- JavaScript selectors and actions: selectors and actions are ordinary JS, with loops,
  conditionals, and function calls. HyperDB gives you fast indexed lookups and
  inserts underneath, not a query language to learn, and the same mental model on
  the client and the server.
- Reactivity: selectors are cached and subscribed. A selector only re-runs
  when a mutation touches a range it actually read.
- Pluggable storage: the same selectors and actions can run against
  any driver: in-memory, IndexedDB, or SQLite (WebAssembly in the browser, native
  on the server).
- Isomorphic: write a slice of schema + selectors + actions once and import
  it on both the client and the server. A server can apply the same actions as a
  client while using a different driver.
- React + devtools: hooks (`useAsyncSelector`, `useAsyncDispatch`,
  `useSyncSelector`, …) and a devtool that traces every selector run and
  mutation, including whether HybridDB reads came from `in-mem` or `persist`.

## When to use HyperDB

HyperDB is a good fit when you want structured, queryable, reactive data with
one data layer shared across your whole stack:

- Local-first apps that work offline and sync to a server in the background,
  plus a server that shares the same schema and sync logic.
- Apps with rich data models (tasks, documents, boards) that need indexed lookups
  and ordering on both client and server.
- Large sorted collections: lists you reorder or insert into with
  fractional indexing, where a plain Redux/MobX array degrades to `O(n)` and a
  B-tree stays `O(log n)`.
- Anywhere you'd otherwise duplicate models and queries between frontend and
  backend, or hand-roll in-memory indexes and manual invalidation.

On the server, the persistent store is SQLite today (MongoDB and PostgreSQL are
not supported yet). HyperDB gives you the storage, query, and reactivity
primitives, not a network layer. Synchronization between peers (clients _and_
servers) is something you build on top with the built-in primitives. The
[Building a Sync Engine](/guides/sync-engine/) guide outlines that design with
change-tracking code shared by the browser and a Bun/SQLite server.

## Installation

```bash
npm install @will-be-done/hyperdb
```

React is a peer dependency, required only if you use the React integration:

```bash
npm install react react-dom
```

The core package ships several entry points:

| Import path                              | Contents                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@will-be-done/hyperdb`                  | Core: `defineTable`, `v`, `selectFrom`, builders, `DB`, `HybridDB`, `SubscribableDB`, runtime helpers |
| `@will-be-done/hyperdb/react`            | React hooks and `DBProvider`                                                              |
| `@will-be-done/hyperdb/tracing`          | Tracing store and tracer configuration                                                    |
| `@will-be-done/hyperdb/drivers/inmemory` | `BptreeInmemDriver`                                                                       |
| `@will-be-done/hyperdb/drivers/sqlite`   | `SqlDriver`, `AsyncSqlDriver`                                                             |
| `@will-be-done/hyperdb/drivers/idb`      | `openIndexedDBDriver`, `IdbDriver`                                                        |

The React devtool ships as a separate package, `@will-be-done/hyperdb-devtool`,
exposing `HyperDBDevtools` from `@will-be-done/hyperdb-devtool/react`.

## Next steps

Read [How HyperDB Works](/start/how-it-works/) for the mental model, then jump
into the [Quickstart](/start/quickstart/). For the cache-first durable runtime,
see [`HybridDB` in the runtime guide](/runtime/db/#hybriddb).
