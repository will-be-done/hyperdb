---
title: Introduction
description: What HyperDB is, the problems it solves, and when to use it.
sidebar:
  order: 1
---

HyperDB is a **universal database for TypeScript**. It gives you typed schemas,
indexed queries, generator-based selectors and actions, pluggable storage
drivers, React hooks, and an in-app devtool.

The defining idea: **the same code runs on the frontend and the backend.** Your
schema, selectors, and actions are written once and executed unchanged in the
browser (over in-memory B+trees, IndexedDB, or WebAssembly SQLite) *and* on the
server (over native SQLite). Only the storage driver differs per environment.

It was inspired by [Convex](https://www.convex.dev/): you model your data with
validators, read it with functions instead of raw SQL, and let the runtime keep
your reads reactive. HyperDB takes that ergonomic model and makes it run
anywhere TypeScript runs — client or server.

## What you get

- **Typed schemas** — `defineTable` + the `v` validator library describe the
  shape of each row and its indexes. Row types, query columns, and index columns
  are all checked by TypeScript.
- **Indexed queries** — a fluent, type-safe query builder (`selectFrom`) reads
  through B-tree and hash indexes with equality, range bounds, ordering, and
  limits. Every table is backed by a real B+tree, so inserting into a sorted
  collection stays `O(log n)` instead of the `O(n)` you pay rebuilding or
  shifting an array.
- **Selectors & actions** — reads and writes are expressed as generator
  functions that *describe* what to do. The runtime executes them, which makes
  the same code work synchronously or asynchronously. Against the in-memory
  driver it runs **fully synchronously** — a dispatch updates the store and the
  UI in the same tick, with no `await` in the hot path.
- **Just JavaScript** — selectors and actions are ordinary JS: loops,
  conditionals, function calls. HyperDB gives you fast indexed lookups and
  inserts underneath, not a query language to learn — the same mental model on
  the client and the server.
- **Reactivity** — selectors are cached and subscribed. A selector only re-runs
  when a mutation touches a range it actually read.
- **Pluggable storage** — the same selectors and actions run unchanged against
  any driver: in-memory, IndexedDB, or SQLite (WebAssembly in the browser, native
  on the server).
- **Isomorphic** — write a slice of schema + selectors + actions once and import
  it on both the client and the server. The server is "just another peer" that
  speaks the same code.
- **React + devtools** — hooks (`useSyncSelector`, `useDispatch`, …) and a
  devtool that traces every selector run and mutation.

## When to use HyperDB

HyperDB is a good fit when you want **structured, queryable, reactive data** with
one data layer shared across your whole stack:

- **Local-first apps** that work offline and sync to a server in the background —
  and a **server** that runs the very same schema and sync logic.
- Apps with rich data models (tasks, documents, boards) that need indexed lookups
  and ordering on both client and server.
- **Large sorted collections** — lists you reorder or insert into with
  fractional indexing, where a plain Redux/MobX array degrades to `O(n)` and a
  B-tree stays `O(log n)`.
- Anywhere you'd otherwise duplicate models and queries between frontend and
  backend, or hand-roll in-memory indexes and manual invalidation.

On the server, the persistent store is SQLite today (MongoDB and PostgreSQL are
not supported yet). HyperDB gives you the storage, query, and reactivity
primitives, not a network layer. Synchronization between peers (clients *and* servers) is something you
build on top with the built-in primitives — the
[Building a Sync Engine](/guides/sync-engine/) guide shows exactly how, with the
same change-tracking code running on the browser and a Bun/SQLite server.

## Installation

```bash
npm install @will-be-done/hyperdb-lib
```

React is a peer dependency, required only if you use the React integration:

```bash
npm install react react-dom
```

The package ships several entry points:

| Import path | Contents |
| --- | --- |
| `@will-be-done/hyperdb-lib` | Core: `defineTable`, `v`, `selectFrom`, builders, `DB`, `SubscribableDB`, runtime helpers |
| `@will-be-done/hyperdb-lib/react` | React hooks and `DBProvider` |
| `@will-be-done/hyperdb-lib/devtool` | `HyperDBDevtools` panel |
| `@will-be-done/hyperdb-lib/tracing` | Tracing store and tracer configuration |
| `@will-be-done/hyperdb-lib/drivers/inmemory` | `BptreeInmemDriver` |
| `@will-be-done/hyperdb-lib/drivers/sqlite` | `SqlDriver`, `AsyncSqlDriver` |
| `@will-be-done/hyperdb-lib/drivers/sqlite/wasm` | `initSqlJsWasm`, `initWasmIDBAsync` |
| `@will-be-done/hyperdb-lib/drivers/idb` | `openIndexedDBDriver`, `IdbDriver` |

## Next steps

Read [How HyperDB Works](/start/how-it-works/) for the mental model, then jump
into the [Quickstart](/start/quickstart/).
