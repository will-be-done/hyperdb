---
title: Storage Drivers
description: In-memory, SQLite, and IndexedDB drivers — and the sync vs. async distinction.
sidebar:
  order: 2
---

A driver is the actual storage backend behind a `DB`. The same selectors and
actions run unchanged against any driver — and in any environment. **The driver
is the single thing you swap between the browser and the server.** You also choose
whether to use the sync or async runtime helpers, which depends on the driver.

## Choosing a driver

| Driver | Import | Mode | Environment | Use for |
| --- | --- | --- | --- | --- |
| `BptreeInmemDriver` | `.../drivers/inmemory` | sync | both | Tests, ephemeral state, the fast in-memory tier |
| `SqlDriver` | `.../drivers/sqlite` | sync | both | Any synchronous SQLite binding (native server SQLite, sql.js) |
| `AsyncSqlDriver` | `.../drivers/sqlite` | async | both | Asynchronous SQLite (e.g. wa-sqlite) |
| `IdbDriver` | `.../drivers/idb` | async | browser | Browser persistence via IndexedDB |

Sync drivers work with `syncDispatch` / `select` / `execSync`. Async drivers
require `asyncDispatch` / `runSelectorAsync` / `execAsync`.

A typical full-stack setup uses an in-memory or IndexedDB driver in the browser
and a native `SqlDriver` on the server — running the *same* schema, selectors,
and actions on both sides.

## In-memory

The simplest driver — a set of in-memory B+trees. Construct it with no arguments.

```ts
import { DB } from "@will-be-done/hyperdb-lib";
import { BptreeInmemDriver } from "@will-be-done/hyperdb-lib/drivers/inmemory";

const memoryDb = new DB(new BptreeInmemDriver());
memoryDb.loadTables([tasksTable]);
```

It stores normalized JS values directly and is the backend you'll use in tests
and as the in-memory working tier of a [local-first sync setup](/guides/sync-engine/).

## SQLite

`SqlDriver` (synchronous) and `AsyncSqlDriver` (asynchronous) are **not tied to
any one SQLite build**. `SqlDriver` wraps any synchronous SQLite binding that you
adapt to a tiny interface:

```ts
interface SQLiteDB {
  exec(sql: string, params?: SqlValue[]): void;
  prepare(sql: string): {
    values(values: SqlValue[]): SqlValue[][]; // bound query → rows as arrays
    finalize(): void;
  };
}
```

That single abstraction is what lets the same driver back the browser (via
WebAssembly SQLite) and the server (via a native binding). The browser
initializers below are just pre-built adapters; the [backend section](#backend-native-sqlite)
shows a native one.

### In the browser (WebAssembly)

WebAssembly initializers are exported from
`@will-be-done/hyperdb-lib/drivers/sqlite/wasm`:

```ts
import { DB, execAsync, asyncDispatch } from "@will-be-done/hyperdb-lib";
import {
  initSqlJsWasm,   // returns a synchronous SqlDriver backed by sql.js
  initWasmIDBAsync, // returns an asynchronous AsyncSqlDriver backed by wa-sqlite
} from "@will-be-done/hyperdb-lib/drivers/sqlite/wasm";

// Synchronous, sql.js-backed
const sqliteDriver = await initSqlJsWasm();
const sqliteDb = new DB(sqliteDriver);
sqliteDb.loadTables([tasksTable]);

// Asynchronous, wa-sqlite-backed (persists through IndexedDB-backed VFS)
const asyncSqliteDriver = await initWasmIDBAsync();
const asyncSqliteDb = new DB(asyncSqliteDriver);
await execAsync(asyncSqliteDb.loadTables([tasksTable]));
```

The SQLite storage codec encodes `bigint`, `ArrayBuffer`, and
typed-array/data-view values around JSON storage so they round-trip exactly.

:::note
`initSqlJsWasm` returns a **synchronous** `SqlDriver` even though
initialization itself is async — once created, use it with the sync helpers.
`initWasmIDBAsync` returns an **asynchronous** `AsyncSqlDriver` — use it with the
async helpers.
:::

## Backend: native SQLite

On the server you back `SqlDriver` with a **native** SQLite binding — there's no
WebAssembly involved. Here is a complete adapter for [Bun's built-in
`bun:sqlite`](https://bun.sh/docs/api/sqlite):

```ts
import { Database } from "bun:sqlite";
import { SqlDriver } from "@will-be-done/hyperdb-lib/drivers/sqlite";
import { DB } from "@will-be-done/hyperdb-lib";

type SqlValue = number | string | Uint8Array | null;

const sqliteDB = new Database("app.sqlite", { strict: true });
sqliteDB.run("PRAGMA journal_mode=WAL;");
sqliteDB.run("PRAGMA synchronous=NORMAL;");
sqliteDB.run("PRAGMA busy_timeout=5000;");

const driver = new SqlDriver({
  exec(sql: string, params?: SqlValue[]): void {
    if (!params) sqliteDB.run(sql);
    else sqliteDB.run(sql, params);
  },
  prepare(sql: string) {
    const stmt = sqliteDB.prepare(sql);
    return {
      values(values: SqlValue[]): SqlValue[][] {
        return stmt.values(...values) as SqlValue[][];
      },
      finalize(): void {
        stmt.finalize();
      },
    };
  },
});

const db = new DB(driver);
db.loadTables([tasksTable]); // the very same tables used in the browser
```

The same shape adapts other native bindings (`better-sqlite3`, Node's built-in
`node:sqlite`, etc.) — implement `exec` and `prepare(...).values()` against the
binding's API. Because the server `DB` runs the identical schema, selectors, and
actions as the client, you can import a shared "slice" of data logic into both:

```ts
// shared between client and server
import { tasksTable, createTask, projectTasks } from "@your-app/slices";

// server (Bun + native SQLite)
syncDispatch(serverDb, createTask({ id, projectId, title }));
const tasks = select(serverDb, projectTasks({ projectId }));
```

This is the foundation of the [sync engine](/guides/sync-engine/): the server is
just another peer running the same change-tracking actions as every client.

## IndexedDB

For durable browser storage, open an `IdbDriver` by name. It is asynchronous, so
load tables and dispatch through the async helpers.

```ts
import { DB, execAsync, asyncDispatch } from "@will-be-done/hyperdb-lib";
import { openIndexedDBDriver } from "@will-be-done/hyperdb-lib/drivers/idb";

const idbDriver = await openIndexedDBDriver("my-app-db");
const idbDb = new DB(idbDriver);
await execAsync(idbDb.loadTables([tasksTable]));

await asyncDispatch(idbDb, createTask({ id: "t1", projectId: "p1", title: "Ship" }));
```

The IndexedDB driver uses the **same storage encoding and sort-key ordering as
the SQLite driver**, so data and index semantics are consistent across the two
persistent backends.

## Sync vs. async, in practice

A common local-first architecture runs **two databases**: an in-memory `DB` for
instant reads/writes, and a persistent (IndexedDB or async SQLite) `DB` that the
in-memory tier is hydrated from and flushed to in the background. That is exactly
the shape of the [sync-engine guide](/guides/sync-engine/) — the in-memory tier
serves the UI synchronously while persistence and cross-tab/server sync happen
asynchronously.

When mixing tiers, remember the rule: a generator that touches an async driver
must be run with `execAsync` / `asyncDispatch` / `runSelectorAsync`; sync drivers
may use either, but the sync helpers are simpler.
