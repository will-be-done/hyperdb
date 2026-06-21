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
any one SQLite build**. HyperDB does not initialize SQLite for you; create the
SQLite database with the package/runtime you prefer, then adapt it to the driver
interface.

For synchronous SQLite, implement this tiny shape and pass it to `SqlDriver`:

```ts
import { SqlDriver, type SqlValue } from "@will-be-done/hyperdb-lib/drivers/sqlite";

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
} from "@will-be-done/hyperdb-lib/drivers/sqlite";

interface AsyncSQLiteDB {
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  prepare(sql: string): Promise<{
    values(values: SqlValue[]): Promise<SqlValue[][]>;
    finalize(): void | Promise<void>;
  }>;
}

const driver = new AsyncSqlDriver(sqliteDb);
```

The SQLite storage codec encodes `bigint`, `ArrayBuffer`, and
typed-array/data-view values around JSON storage so they round-trip exactly.

## SQLite Recipes

### SQL.js sync

```ts
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { DB } from "@will-be-done/hyperdb-lib";
import {
  SqlDriver,
  type SQLStatement,
  type SqlValue,
} from "@will-be-done/hyperdb-lib/drivers/sqlite";

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
db.loadTables([tasksTable]);
```

`SqlDriver` is synchronous. Even if sql.js initialization is async, use the
created driver with `select`, `syncDispatch`, and `execSync`.

### wa-sqlite async

```ts
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import asyncSqlWasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import * as SQLite from "wa-sqlite";
import { MemoryAsyncVFS } from "wa-sqlite/src/examples/MemoryAsyncVFS.js";
import { DB, execAsync } from "@will-be-done/hyperdb-lib";
import {
  AsyncSqlDriver,
  type AsyncSQLiteDB,
  type SqlValue,
} from "@will-be-done/hyperdb-lib/drivers/sqlite";

type WaSQLiteValue = number | string | Uint8Array | Array<number> | bigint | null;
type WaSQLiteDB = {
  bind_collection(
    stmt: number,
    bindings: { [index: string]: WaSQLiteValue | null } | Array<WaSQLiteValue | null>,
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

const vfs = await MemoryAsyncVFS.create("my-app-db", module);
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
`asyncDispatch`, and `runSelectorAsync`.

### Bun sync

```ts
import { Database } from "bun:sqlite";
import { DB } from "@will-be-done/hyperdb-lib";
import { SqlDriver, type SqlValue } from "@will-be-done/hyperdb-lib/drivers/sqlite";

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

The same sync shape adapts other native bindings (`better-sqlite3`, Node's
built-in `node:sqlite`, etc.) — implement `exec` and
`prepare(...).values()` against the binding's API. Because the server `DB` runs
the identical schema, selectors, and actions as the client, you can import a
shared "slice" of data logic into both:

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
