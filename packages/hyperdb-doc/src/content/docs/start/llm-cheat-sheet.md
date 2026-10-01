---
title: LLM Cheat Sheet
description: A compact HyperDB reference you can paste into another project for LLM context.
sidebar:
  order: 5
---

Use this file as short LLM context for HyperDB. Full docs:
https://hyperdb.will-be-done.app/

Good deep links:

- Quickstart: https://hyperdb.will-be-done.app/start/quickstart/
- Schemas: https://hyperdb.will-be-done.app/database/schemas/
- Selectors: https://hyperdb.will-be-done.app/database/selectors/
- Reading data: https://hyperdb.will-be-done.app/database/reading-data/
- Actions: https://hyperdb.will-be-done.app/database/actions/
- React: https://hyperdb.will-be-done.app/integrations/react/
- Drivers: https://hyperdb.will-be-done.app/runtime/drivers/

## What HyperDB Does

HyperDB is a TypeScript database layer for local-first apps. It gives you typed
schemas, indexed reads, transactional writes, selector reactivity, React hooks,
and pluggable storage drivers. The same schema, selectors, and actions can run
in the browser and on the server; only the storage driver changes.

Use it when an app needs structured reactive data instead of plain component
state, Redux arrays, or hand-written indexes. It is especially useful for
offline/local-first apps, sorted collections, reusable client/server data logic,
and views that should re-run only when the exact index ranges they read change.

## Package Entry Points

- `@will-be-done/hyperdb`: core APIs such as schemas, validators, selectors,
  actions, runtimes, command executors, `HybridDB`, `SubscribableDB`, tracing
  setup, and core types.
- `@will-be-done/hyperdb/react`: `DBProvider`, `useDB`, `useOptionalDB`,
  `useSyncSelector`, `useAsyncSelector`, `useSyncDispatch`, `useAsyncDispatch`,
  `useSelectSync`, and `useSelectAsync`.
- `@will-be-done/hyperdb/tracing`: tracing store, tracer configuration, and
  trace metadata helpers.
- `@will-be-done/hyperdb/drivers/inmemory`: `BptreeInmemDriver`.
- `@will-be-done/hyperdb/drivers/sqlite`: `SqlDriver`, `AsyncSqlDriver`, and
  SQLite adapter types. `AsyncSqlDriver` is compatible with Turso Database's
  browser WASM build.
- `@will-be-done/hyperdb/drivers/idb`: `openIndexedDBDriver`, `IdbDriver`, and
  IndexedDB driver options.
- `@will-be-done/hyperdb-devtool/react`: separate package with
  `HyperDBDevtools` and `HyperDBDevtoolsPanel`.

## Core Imports To Reach For

```ts
import {
  DB,
  HybridDB,
  PreloadedHybridDB,
  SubscribableDB,
  asyncDispatch,
  createAction,
  createAsyncSelectorStore,
  createCachedSelectorStoreAsync,
  createSelector,
  createCachedSelectorStoreSync,
  defineTable,
  deleteRows,
  execAsync,
  execMaybeAsync,
  execSync,
  getCurrentTraits,
  insert,
  or,
  preloadSelectorAsync,
  selectAsync,
  selectCachedMaybeAsync,
  selectSync,
  selectFrom,
  syncDispatch,
  upsert,
  v,
  type ExtractSchema,
  type HyperDB,
} from "@will-be-done/hyperdb";
```

## Schema Pattern

Every table needs a string `id`. HyperDB creates a built-in `uniqhash` index
named `byId`. Add B-tree indexes for sorted/range reads and `uniqhash` indexes
for exact values that must be unique.

```ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  slug: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
  completedAt: v.optional(v.number()),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  .index("bySlug", ["slug"], { type: "uniqhash" })
  .index("byIds", ["id"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

Useful validators: `v.string()`, `v.number()`, `v.bigint()`, `v.boolean()`,
`v.null()`, `v.arrayBuffer()`, `v.array(...)`, `v.object(...)`,
`v.record(...)`, `v.union(...)`, `v.literal(...)`, `v.optional(...)`,
`v.partial(...)`, `v.required(...)`, `v.lazy(...)`, `v.pass<T>()`, and
`v.any()`.

Stored rows cannot contain `undefined` except where optional object fields are
omitted. Arrays and records cannot contain `undefined`.

## Selectors And Reads

Create one shared selector builder and reuse it.

```ts
import { createSelector, selectFrom, v } from "@will-be-done/hyperdb";
import { tasksTable } from "./schema";

export const selector = createSelector({
  validateArgs: process.env.NODE_ENV === "development",
});

export const projectTasks = selector({
  name: "projectTasks",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    return yield* selectFrom(tasksTable, "byProjectOrder")
      .where((q) => q.eq("projectId", projectId))
      .order("asc");
  },
});
```

`selectFrom(table, index)` supports `.where(...)`, `.order("asc" | "desc")`,
`.limit(n)`, `.first()`, and `.firstOr(fallback)`. Filter operators are
`eq`, `lt`, `lte`, `gt`, and `gte`.

OR queries can return an array or use `or(...)`:

```ts
yield *
  selectFrom(tasksTable, "byProjectOrder").where((q) =>
    or(q.eq("projectId", "p1"), q.eq("projectId", "p2")),
  );
```

Run selectors outside React with `selectSync`, `selectAsync`,
`selectCachedMaybeAsync`, or `preloadSelectorAsync`. Use sync helpers with sync
drivers and async helpers with async drivers:

```ts
const rows = selectSync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
const asyncRows = await selectAsync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
const cachedRows = await Promise.resolve(
  selectCachedMaybeAsync(db, {
    selector: projectTasks,
    args: { projectId: "p1" },
  }),
);
```

For subscriptions outside React, use a selector store. Pick sync vs async by
whether the selector may yield a promise, and cached vs uncached by whether the
root selector result should be shared:

```ts
const store = createCachedSelectorStoreAsync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
  defaultValue: [],
});

const unsubscribe = store.subscribe(() => {
  const snapshot = store.getSnapshot();
  if (snapshot.status === "success") console.log(snapshot.data);
});
```

Store helpers: `createSelectorStoreSync` (sync uncached),
`createCachedSelectorStoreSync` (sync cached), `createAsyncSelectorStore`
(async uncached), and `createCachedSelectorStoreAsync` (async cached).

## Actions And Writes

Create one shared action builder and reuse it. Actions are generator functions
that run inside a transaction. Use `insert`, `upsert`, and `deleteRows`.

```ts
import {
  asyncDispatch,
  createAction,
  insert,
  selectFrom,
  upsert,
  v,
} from "@will-be-done/hyperdb";
import { tasksTable } from "./schema";

export const action = createAction({
  validateArgs: process.env.NODE_ENV === "development",
});

export const createTask = action({
  name: "createTask",
  args: { id: v.string(), projectId: v.string(), title: v.string() },
  handler: function* ({ id, projectId, title }) {
    yield* insert(tasksTable, [
      { id, projectId, title, slug: id, state: "todo", orderToken: id },
    ]);
  },
});

export const completeTask = action({
  name: "completeTask",
  args: { id: v.string() },
  handler: function* ({ id }) {
    const task = yield* selectFrom(tasksTable, "byId")
      .where((q) => q.eq("id", id))
      .first();
    if (!task) return;
    yield* upsert(tasksTable, [{ ...task, state: "done" }]);
  },
});

await asyncDispatch(
  db,
  createTask({ id: "t1", projectId: "p1", title: "Ship" }),
);
```

Use `await asyncDispatch(db, action(...))` for HybridDB and other asynchronous
drivers. Use `syncDispatch(db, action(...))` only for synchronous drivers.
`insert` fails on duplicate ids, `upsert` replaces whole rows by id, and
`deleteRows` deletes by id.

## HybridDB Setup

For durable frontend data, prefer `HybridDB`: persistent primary storage plus an
in-memory cache. The primary can be IndexedDB or async SQLite; the cache is
normally `BptreeInmemDriver`.

```ts
import { DB, HybridDB, SubscribableDB, execAsync } from "@will-be-done/hyperdb";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { tasksTable } from "./schema";

export async function createAppDB() {
  const primary = new DB(await openIndexedDBDriver("my-app"), {
    runtimeRowsValidation: process.env.NODE_ENV === "development",
    freezeArgs: process.env.NODE_ENV === "development",
    freezeRows: process.env.NODE_ENV === "development",
  });
  const cache = new DB(new BptreeInmemDriver());
  const db = new SubscribableDB(new HybridDB(primary, cache));

  await execAsync(db.loadTables([tasksTable]));
  await execAsync(
    db.preloadTables([{ table: tasksTable, scanIndex: "byIds" }]),
  );

  return db;
}
```

Persistent driver diagnostics are opt-in. Pass `debug(event) { ... }` to
`openIndexedDBDriver(...)` or `new AsyncSqlDriver(...)` for structured low-level
storage events; without a callback, drivers stay quiet and skip diagnostic event
preparation. Use `logIdbDriverDebugEvent` from
`@will-be-done/hyperdb/drivers/idb` to print IDB events in the old one-line
console style, and `logAsyncSqlDriverDebugEvent` from
`@will-be-done/hyperdb/drivers/sqlite` for async SQLite.

SQLite `loadTables()` stores physical-layout signatures in the reserved
`_hyperdb_schema_metadata` table. Unchanged definitions use a one-query fast
path; a changed definition or SQLite `schema_version` triggers full
transactional schema reconciliation.

Use a B-tree full-scan index such as `byIds` for `preloadTables`; the built-in
`byId` index is a `uniqhash` index for exact id lookups. `SubscribableDB` adds
revisions, subscriptions, selector invalidation, and lifecycle hooks. Pure
in-memory apps can skip `HybridDB` and use `new SubscribableDB(new DB(new
BptreeInmemDriver()))`.

HybridDB readwrite transactions commit to the in-memory cache first and flush
their final row changes to the persistent primary afterward. This keeps
`asyncDispatch` responsive for UI writes. Cached scan intervals keep reading
from memory while persistence is pending; partially cached scans load only the
uncovered portions from the primary store and wait for pending flushes only when
pending old or new row values can affect those primary-read portions. Exact
`uniqhash` lookups are marked cached when rows are loaded from
persistence or when the cache transaction commits, so `byId` and other unique
equality reads can return from memory while persistence is still pending.
Write transaction scans reuse coverage already known by the committed cache.

Use `new HybridDB(primary, cache, { debug: true })` to log why an uncached scan
fell through to persistence, waited for pending persistence, or retried a
failed background flush. Use a callback for structured `HybridDBDebugEvent`
objects.

If a background flush keeps failing past its bounded retries, HybridDB enters a
permanent crashed state: `hybrid.isCrashed` becomes `true` and every subsequent
read, write, or transaction (including cache-only reads) throws
`HybridDBCrashedError` with the persistence error as its `cause`. Recover by
creating a new `HybridDB` and reloading tables.

For datasets where every index key fits in memory but every full row does not,
use `PreloadedHybridDB`:

```ts
import {
  DB,
  PreloadedHybridDB,
  SubscribableDB,
  externalStorageMergeTrait,
  execAsync,
} from "@will-be-done/hyperdb";

const db = new SubscribableDB(
  new PreloadedHybridDB(primary, { preloadConcurrency: "whole" }),
);
await execAsync(db.loadTables([tasksTable, projectsTable]));
```

`loadTables` automatically preloads all declared indexes with entity IDs as
their leaves, including non-ID `uniqhash` value-to-ID pointers. Calls are
incremental: existing tables remain loaded while supplied definitions are added
or refreshed. Supplied tables preload concurrently by default; use a positive
numeric `preloadConcurrency` to cap active reads (`1` is sequential), or
`"whole"` to start all supplied tables. Drivers may serialize internally, and
greater concurrency raises temporary startup memory. A bounded scan resolves
IDs from memory and dereferences them
through the built-in `byId` `uniqhash`. Unresolved `byId` entries are batch-loaded
from the primary and then reused by reads through every index. Do not add a
`byIds` B-tree or call `preloadTables` for this runtime. Reads remain async, and
writes wait for primary persistence before publishing copy-on-write index
changes.
Exact `byId` misses check the primary so rows added by another connected runtime
can be discovered and incorporated into the preloaded indexes.
For a changeset already persisted by another runtime sharing the primary, run
its merge with `externalStorageMergeTrait` and the app's change-tracking
suppression trait. The merge then updates the preloaded snapshot through normal
transaction operations, subscribers receive normal invalidations, and an
external insert is persisted idempotently rather than failing as a duplicate.

## React Pattern

```tsx
import {
  DBProvider,
  useAsyncDispatch,
  useAsyncSelector,
} from "@will-be-done/hyperdb/react";
import type { SubscribableDB } from "@will-be-done/hyperdb";
import { HyperDBDevtools } from "@will-be-done/hyperdb-devtool/react";
import { createTask, projectTasks } from "./tasks";

function Tasks({ projectId }: { projectId: string }) {
  const { data: tasks = [], isFetching } = useAsyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });
  const dispatch = useAsyncDispatch();

  return (
    <button
      disabled={isFetching}
      onClick={() =>
        void dispatch(
          createTask({
            id: crypto.randomUUID(),
            projectId,
            title: "New task",
          }),
        )
      }
    >
      Add {tasks.length + 1}
    </button>
  );
}

export function App({ db }: { db: SubscribableDB }) {
  return (
    <DBProvider value={db}>
      <Tasks projectId="p1" />
      <HyperDBDevtools db={db} initialIsOpen={false} />
    </DBProvider>
  );
}
```

Use `useAsyncSelector` and `useAsyncDispatch` with HybridDB. `useAsyncSelector`
returns a React Query-style result with `data`, `status`, `error`, fetching
flags, and `refetch()`. Its initial snapshot attempts the selector once: sync
results are visible immediately, while promise results show `defaultValue`,
`initialData`, or `placeholderData` until that promise resolves. `defaultValue`
may be a value or a zero-argument function that returns the value. Use
`useSyncSelector` / `useSyncDispatch` only for purely synchronous drivers.

## Rules Of Thumb

- Prefer selectors for reads and actions for writes.
- Do not write inside selectors.
- Define indexes for every query shape; query filters must fit the selected
  index.
- Use `byId` for id lookups.
- Prefer HybridDB for durable browser state: persistent primary, in-memory
  cache, async selectors, and async dispatch.
- Use B-tree indexes for ordering, ranges, composite keys, and full-table
  preloading.
- Use `uniqhash` when an exact single-column value must be unique.
- For partial updates, read the current row and `upsert` the complete next row.
- Keep schema, selectors, and actions in shared modules/packages so client and server can
  import the same data layer.
