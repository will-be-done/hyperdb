---
title: Storage Drivers
description: In-memory, SQLite, and IndexedDB drivers, and the sync vs. async distinction.
sidebar:
  order: 2
---

A driver is the actual storage backend behind a `DB`. The same selectors and
actions run unchanged against any driver, and in any environment. You can use a
single driver directly, or combine a persistent primary driver with an in-memory
cache through [`HybridDB`](/runtime/db/#hybriddb). You also choose whether to use
the sync or async runtime helpers, which depends on the storage path.

## Choosing a driver

| Driver              | Import                 | Mode  | Environment | Use for                                                        |
| ------------------- | ---------------------- | ----- | ----------- | -------------------------------------------------------------- |
| `BptreeInmemDriver` | `.../drivers/inmemory` | sync  | both        | Tests, fully loaded app state, and the fast `HybridDB` cache   |
| `IdbDriver`         | `.../drivers/idb`      | async | browser     | Browser persistence, usually as a `HybridDB` primary store     |
| `SqlDriver`         | `.../drivers/sqlite`   | sync  | both        | Any synchronous SQLite binding (native server SQLite, sql.js)  |
| `AsyncSqlDriver`    | `.../drivers/sqlite`   | async | both        | Async SQLite, including browser SQLite as a `HybridDB` primary |

Sync drivers work with `execSync` / `syncDispatch` / `selectSync`. Async drivers
require `execAsync` / `asyncDispatch` / `selectAsync`. `HybridDB` also uses the
async helpers, because a read may miss the memory cache and fall through to the
primary store.

A typical local-first browser setup uses `HybridDB` with IndexedDB or async
SQLite as the primary store and `BptreeInmemDriver` as the cache. If your whole
working set can be loaded eagerly, a plain `SubscribableDB` over
`BptreeInmemDriver` keeps the UI path fully synchronous. On the server, use a
native `SqlDriver` while running the _same_ schema, selectors, and actions.

## In-memory

The simplest driver: a set of in-memory B+trees. Construct it with no arguments.

```ts
import { DB, execSync } from "@will-be-done/hyperdb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";

const memoryDb = new DB(new BptreeInmemDriver());
execSync(memoryDb.loadTables([tasksTable]));
```

It stores normalized JS values directly. Use it in tests, for app state that can
be fully loaded into memory, or as the cache tier inside `HybridDB`.

## SQLite

`SqlDriver` (synchronous) and `AsyncSqlDriver` (asynchronous) are not tied to
any one SQLite build. HyperDB does not initialize SQLite for you; create the
SQLite database with the package/runtime you prefer, then adapt it to the driver
interface.

For synchronous SQLite, implement this tiny shape and pass it to `SqlDriver`:

```ts
import { SqlDriver, type SqlValue } from "@will-be-done/hyperdb/drivers/sqlite";

export interface SQLiteDB {
  exec(sql: string, params?: SqlValue[]): void;
  prepare(sql: string): {
    values(values: SqlValue[]): SqlValue[][]; // bound query → rows as arrays
    finalize(): void;
  };
}

const driver = new SqlDriver(sqliteDb);
```

For asynchronous SQLite, implement the same shape with promises and pass it to
`AsyncSqlDriver`:

```ts
import {
  AsyncSqlDriver,
  type SqlValue,
} from "@will-be-done/hyperdb/drivers/sqlite";

interface AsyncSQLiteDB {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  prepare(sql: string): Promise<{
    values(values: SqlValue[]): Promise<SqlValue[][]>;
    finalize(): void | Promise<void>;
  }>;
}

const driver = new AsyncSqlDriver(sqliteDb);
```

`AsyncSqlDriver` is quiet by default. For low-level SQL diagnostics, pass a
`debug` callback:

```ts
import { logAsyncSqlDriverDebugEvent } from "@will-be-done/hyperdb/drivers/sqlite";

const driver = new AsyncSqlDriver(sqliteDb, {
  debug: logAsyncSqlDriverDebugEvent,
});
```

The callback receives structured `AsyncSqlDriverDebugEvent` objects with the
operation, status, SQL text, duration, optional table/index names, row counts,
parameter summaries, and errors. When no callback is configured, the driver does
not prepare or emit SQL diagnostic events. Use
`formatAsyncSqlDriverDebugEvent(event)` when you want the old one-line message
but need to send it to a custom logger.

The SQLite storage codec encodes `bigint`, `ArrayBuffer`, and
typed-array/data-view values around JSON storage so they round-trip exactly.
`uniqhash` indexes are created as SQLite `UNIQUE` indexes. Upserts delete the
same primary keys first and then insert the new rows, so a secondary unique
conflict throws instead of replacing a different row.

SQLite stores ordered index keys as compact binary BLOBs. The encoding preserves
HyperDB's JavaScript/UTF-16 comparator, including the final `id` tie-breaker on
non-unique indexes. The built-in exact `byId` access path uses the SQLite primary
key directly, rejects empty or malformed equality bounds, and returns each ID
once when an OR query repeats it. Matching single-column `uniqhash` and B-tree
declarations share one unique physical index. Older textual sort-key columns are
replaced and backfilled automatically when tables are loaded.

The SQLite drivers support large batches of OR selector clauses, within
SQLite's bind-parameter limit, without requiring application code to use tiny
batches to stay below SQLite's expression-depth limit.

## SQLite Recipes

### SQL.js sync

```ts
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { DB, execSync } from "@will-be-done/hyperdb";
import {
  SqlDriver,
  type SQLStatement,
  type SqlValue,
} from "@will-be-done/hyperdb/drivers/sqlite";

const SQL = await initSqlJs({
  locateFile: () => wasmUrl,
});
const sqljsDb = new SQL.Database();

const driver = new SqlDriver({
  exec(sql: string, params?: SqlValue[]): void {
    sqljsDb.exec(sql, params);
  },
  prepare(sql: string): SQLStatement {
    const stmt = sqljsDb.prepare(sql);
    return {
      values(values: SqlValue[]): SqlValue[][] {
        stmt.bind(values);

        const rows: SqlValue[][] = [];
        while (stmt.step()) {
          rows.push(stmt.get());
        }
        return rows;
      },
      finalize(): void {
        stmt.free();
      },
    };
  },
});

const db = new DB(driver);
execSync(db.loadTables([tasksTable]));
```

`SqlDriver` is synchronous. Even if sql.js initialization is async, use the
created driver with `selectSync`, `syncDispatch`, and `execSync`.

### wa-sqlite async

```ts
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import asyncSqlWasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import * as SQLite from "wa-sqlite";
import { MemoryAsyncVFS } from "wa-sqlite/src/examples/MemoryAsyncVFS.js";
import { DB, execAsync } from "@will-be-done/hyperdb";
import {
  AsyncSqlDriver,
  type AsyncSQLiteDB,
  type SqlValue,
} from "@will-be-done/hyperdb/drivers/sqlite";

type WaSQLiteValue =
  | number
  | string
  | Uint8Array
  | Array<number>
  | bigint
  | null;
type WaSQLiteDB = {
  bind_collection(
    stmt: number,
    bindings:
      | { [index: string]: WaSQLiteValue | null }
      | Array<WaSQLiteValue | null>,
  ): number;
  statements(db: number, sql: string): AsyncIterable<number>;
  step(stmt: number): Promise<number>;
  row(stmt: number): WaSQLiteValue[];
  vfs_register(vfs: unknown, makeDefault: boolean): void;
  open_v2(name: string): Promise<number>;
};

const SQLITE_ROW = 100;

const module = await SQLiteAsyncESMFactory({
  locateFile: () => asyncSqlWasmUrl,
});
const sqlite3 = SQLite.Factory(module) as WaSQLiteDB;

const vfs = new MemoryAsyncVFS();
sqlite3.vfs_register(vfs, true);

const dbHandle = await sqlite3.open_v2("main.sqlite");
const sqliteDb: AsyncSQLiteDB = {
  async exec(sql: string, params?: SqlValue[]): Promise<void> {
    for await (const stmt of sqlite3.statements(dbHandle, sql)) {
      if (params) sqlite3.bind_collection(stmt, params);
      await sqlite3.step(stmt);
    }
  },
  async prepare(sql: string) {
    return {
      async values(values: SqlValue[]): Promise<SqlValue[][]> {
        const rows: SqlValue[][] = [];

        for await (const stmt of sqlite3.statements(dbHandle, sql)) {
          sqlite3.bind_collection(stmt, values);

          while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
            rows.push(sqlite3.row(stmt) as SqlValue[]);
          }
        }

        return rows;
      },
      finalize(): void {
        // wa-sqlite finalizes scoped statements after iteration.
      },
    };
  },
};
const driver = new AsyncSqlDriver(sqliteDb);

const db = new DB(driver);
await execAsync(db.loadTables([tasksTable]));
```

`AsyncSqlDriver` is asynchronous, so use it with `execAsync`,
`asyncDispatch`, and `selectAsync`.

For persistent browser SQLite, swap the memory VFS for WA-SQLite's OPFS VFS:

```ts
import { OriginPrivateFileSystemVFS } from "wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js";

const vfs = new OriginPrivateFileSystemVFS();
sqlite3.vfs_register(vfs, true);

const dbHandle = await sqlite3.open_v2("main.sqlite");
```

`OriginPrivateFileSystemVFS` uses OPFS access handles, so run this setup in a
module Worker and expose an `AsyncSQLiteDB`-shaped RPC (`exec` and
`prepare().values()`) to the main thread. The HyperDB demo uses that pattern for
direct WA-SQLite OPFS access and for WA-SQLite OPFS as a `HybridDB` primary
store.

### Backend: native SQLite

On the server, point `SqlDriver` at a native SQLite binding, here Bun's built-in
`bun:sqlite`:

```ts
import { Database } from "bun:sqlite";
import { DB, execSync } from "@will-be-done/hyperdb";
import { SqlDriver, type SqlValue } from "@will-be-done/hyperdb/drivers/sqlite";

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
execSync(db.loadTables([tasksTable])); // the very same tables used in the browser
```

The same sync shape adapts other native bindings (`better-sqlite3`, Node's
built-in `node:sqlite`, etc.); implement `exec` and
`prepare(...).values()` against the binding's API. Because the server `DB` runs
the identical schema, selectors, and actions as the client, you can import a
shared "slice" of data logic into both:

```ts
// shared between client and server
import { tasksTable, createTask, projectTasks } from "@your-app/slices";

// server (Bun + native SQLite)
syncDispatch(serverDb, createTask({ id, projectId, title }));
const tasks = selectSync(serverDb, {
  selector: projectTasks,
  args: { projectId },
});
```

This is the foundation of the [sync engine](/guides/sync-engine/): the server
can run the same change-tracking actions as clients.

## IndexedDB

For persistent browser storage, open an `IdbDriver` by name. It is asynchronous,
so load tables and dispatch through the async helpers. In a local-first app, it
is commonly the primary store behind `HybridDB`.

```ts
import { DB, execAsync, asyncDispatch } from "@will-be-done/hyperdb";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";

const idbDriver = await openIndexedDBDriver("my-app-db");
const idbDb = new DB(idbDriver);
await execAsync(idbDb.loadTables([tasksTable]));

await asyncDispatch(
  idbDb,
  createTask({ id: "t1", projectId: "p1", title: "Ship" }),
);
```

The IndexedDB driver uses the same storage encoding and sort-key ordering as
the SQLite driver, so data and index semantics are consistent across the two
persistent backends. Sort keys are stored as compact binary keys. Exact `byId`
reads use the object-store primary key, validate string-ID equality conditions,
and deduplicate repeated IDs. Matching single-column `uniqhash`/B-tree
declarations share one native IndexedDB index. Sort-key format changes rewrite
index entries atomically during schema refresh.

IndexedDB reports selector readonly transaction support,
so selector reads use `beginTx("readonly")`; when multiple scans happen inside
one selector run while the browser keeps a readonly transaction active, the
driver reuses it instead of opening one transaction per scan. Concurrent
selector runs get separate readonly transactions, and an inactive or finished
readonly transaction is reopened once for the current scan.
IndexedDB `uniqhash` indexes are native unique indexes. If an index changes
between non-unique and `uniqhash`, HyperDB recreates the IndexedDB index during
the schema upgrade.

The IndexedDB driver is quiet by default. For low-level storage diagnostics,
pass a `debug` callback:

```ts
import { logIdbDriverDebugEvent } from "@will-be-done/hyperdb/drivers/idb";

const idbDriver = await openIndexedDBDriver("my-app-db", {
  debug: logIdbDriverDebugEvent,
});
```

The callback receives structured `IdbDriverDebugEvent` objects for operations
such as scans, writes, transaction starts/commits/rollbacks, readonly
transaction reopens, and index rebuilds. Events include duration, transaction
id, table/index names, row counts, status, errors, and selector/action run
context when available. When no callback is configured, the driver does not
prepare or emit IDB diagnostic events. Use `formatIdbDriverDebugEvent(event)`
when you want the old one-line message but need to send it to a custom logger.

## Sync vs. async, in practice

Use a synchronous driver when the whole read path can stay in memory or in a
sync SQLite binding. That gives you `selectSync`, `syncDispatch`, `useSyncSelector`,
and `useSyncDispatch` with no promises.

Use an asynchronous driver when storage itself is asynchronous, such as
IndexedDB, async SQLite, or `HybridDB`. `HybridDB` can still serve warm reads
from its in-memory cache, but the public API remains async because any selector
may touch an uncached range and need the primary store.

The rule is simple: a generator that might touch an async storage path must be
run with `execAsync` / `asyncDispatch` / `selectAsync`; purely sync paths may use
`execSync` / `syncDispatch` / `selectSync`.
