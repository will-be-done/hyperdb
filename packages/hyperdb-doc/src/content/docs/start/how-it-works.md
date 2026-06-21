---
title: How HyperDB Works
description: The three layers of HyperDB — tables, generator commands, and the DB runtime.
sidebar:
  order: 2
---

HyperDB is built from three layers. Understanding how they fit together explains
almost everything else in these docs.

## The three layers

### 1. Tables

Tables describe the **shape of a stored row** and its **named indexes**. You
declare them with `defineTable` and the `v` validator library. A table is just a
description — it holds no data and is not tied to any database instance, so you
can share the same table definitions across many `DB`s.

```ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb-lib";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
}).index("byProjectOrder", ["projectId", "orderToken"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

See [Schemas](/database/schemas/) and [Data Types](/database/data-types/).

### 2. Commands: selectors and actions

Reads and writes are **generator functions** that *describe* work instead of
performing it directly. When you `yield*` a query or a mutation, you are emitting
a command; you never call the storage driver yourself.

- **Selectors** read data. They can compose other selectors but cannot write.
- **Actions** read and write data. They emit `insert`, `upsert`, and
  `deleteRows` commands.

```ts
import { selectFrom } from "@will-be-done/hyperdb-lib";
import { selector, action } from "./builders"; // createSelector()/createAction()
import { insert } from "@will-be-done/hyperdb-lib";

export const projectTasks = selector({
  name: "projectTasks",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    return yield* selectFrom(tasksTable, "byProjectOrder")
      .where((q) => q.eq("projectId", projectId))
      .order("asc");
  },
});

export const createTask = action({
  name: "createTask",
  args: { id: v.string(), projectId: v.string(), title: v.string() },
  handler: function* ({ id, projectId, title }) {
    yield* insert(tasksTable, [
      { id, projectId, title, state: "todo", orderToken: id },
    ]);
  },
});
```

Because commands are *descriptions*, the same selector or action can be executed
synchronously against an in-memory driver, or asynchronously against IndexedDB —
the code does not change. See [Reading Data](/database/reading-data/) and
[Writing Data](/database/writing-data/).

### 3. The DB runtime

A `DB` ties a set of tables to a **storage driver** and executes commands. The
driver provides the actual backend: in-memory B+trees, SQLite, or IndexedDB.

```ts
import { DB, SubscribableDB } from "@will-be-done/hyperdb-lib";
import { BptreeInmemDriver } from "@will-be-done/hyperdb-lib/drivers/inmemory";

const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
db.loadTables([tasksTable]);
```

You typically wrap the core `DB` in a [`SubscribableDB`](/runtime/db/), which
adds revisions, subscriptions, and lifecycle hooks — the machinery that makes
selectors reactive.

**The driver is the only thing that changes between environments.** The exact
same tables and commands run on a server by handing `DB` a native SQLite driver
instead:

```ts
import { Database } from "bun:sqlite";
import { SqlDriver } from "@will-be-done/hyperdb-lib/drivers/sqlite";

const sqlite = new Database("app.sqlite", { strict: true });
const serverDb = new DB(makeSqlDriver(sqlite)); // same tasksTable, same selectors
serverDb.loadTables([tasksTable]);
```

See [Storage Drivers](/runtime/drivers/#backend-native-sqlite) for the full
adapter.

## How a read becomes reactive

This is the loop that powers HyperDB's reactivity:

1. You run a selector through the runtime (or a React hook).
2. As the selector scans indexes, the runtime records **which index ranges it
   touched**.
3. The result is cached, keyed by the selector and a stable serialization of its
   arguments.
4. When an action commits a mutation, the `SubscribableDB` notifies subscribers
   with the list of changed rows.
5. A cached selector re-runs **only if** a changed row falls inside a range it
   previously scanned. Otherwise the cached value is reused.

The result: precise, automatic invalidation without you writing any
subscription bookkeeping. The details live in
[Selectors & Reactivity](/database/selectors-reactivity/).

## Sync vs. async execution

Every driver is either synchronous (in-memory, sync SQLite) or asynchronous
(IndexedDB, async SQLite). The runtime exposes a matching pair of entry points
for almost everything:

| Sync | Async |
| --- | --- |
| `syncDispatch(db, action(args))` | `asyncDispatch(db, action(args))` |
| `select(db, gen)` | `runSelectorAsync(db, () => gen)` |
| `execSync(generator)` | `execAsync(generator)` |
| `useSyncSelector` / `useDispatch` | `useAsyncSelector` / `useAsyncDispatch` |

Use the sync variants with the in-memory and synchronous SQLite drivers; use the
async variants with IndexedDB and async SQLite. See
[The DB Runtime](/runtime/db/) and [Storage Drivers](/runtime/drivers/).
