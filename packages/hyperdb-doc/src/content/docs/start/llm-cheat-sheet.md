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
- Undo/redo: https://hyperdb.will-be-done.app/integrations/undo/

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
- `@will-be-done/hyperdb/undo`: `undoMiddleware`, `UndoManager`, `withoutUndo`,
  `undoIgnore`, `isUndoReplay`, `UndoConflictError`, and history types.
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
  dispatchMaybeAsync,
  DuplicateIdError,
  execAsync,
  execMaybeAsync,
  execSync,
  getCurrentTraits,
  HyperDBError,
  insert,
  isHyperDBError,
  or,
  preloadSelectorAsync,
  selectAsync,
  selectCachedMaybeAsync,
  selectSync,
  selectFrom,
  syncDispatch,
  upsert,
  v,
  ValidationError,
  type ActionGenerator,
  type ExtractSchema,
  type HyperDB,
  type HyperDBErrorCode,
  type SelectorGenerator,
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

Validators have an output type (`Infer`, `ExtractSchema<typeof table>`) and an
input type (`InferInput`, `ExtractSchemaInput<typeof table>`). They differ for
`v.arrayBuffer()`, which accepts typed arrays and `DataView`s on writes and
always returns an `ArrayBuffer`; `insert`/`upsert` take the input row type.
Action and selector args use the output type.

Stored rows cannot contain `undefined` except where optional object fields are
omitted. Arrays and records cannot contain `undefined`.

`.with(...)` attaches inert annotations to a column validator or a table for
plugins to read; it returns a copy. Define one with
`defineAnnotation(key, create?)`, then read it with `annotation.of(table)`
(table value), `annotation.fields(table)`, or `annotation.columns(table)`.
Optional columns carry their inner validator's annotations.

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
`dispatchMaybeAsync(db, action(...))` returns the result directly when nothing
had to wait and a promise otherwise. `insert` fails on duplicate ids, `upsert`
replaces whole rows by id, and `deleteRows` deletes by id.

## Errors And Closing

A failed read or write raises its error at the handler's `yield*`, so
`try` / `catch` / `finally` work in actions and selectors; uncaught errors roll
the transaction back. Failed writes leave no partial effect, so catching (for
example a `DuplicateIdError`, then `upsert`) and continuing is safe, except on a
bare IndexedDB driver, where a failed request aborts the whole transaction and
the dispatch rejects anyway. A failing mutation hook also blocks the commit,
even if the handler catches its error. Selectors never write, even inside an
action.

Runtime errors extend `HyperDBError` with a stable `code` (definition mistakes,
such as a blank action name or conflicting query conditions, throw plain
`Error`); match on the code,
not the message. `isHyperDBError(error, "DUPLICATE_ID")` narrows and works
across duplicate package copies. Every driver reports primary-key collisions
as `DuplicateIdError` (`id`), even when the row also breaks a `uniqhash`
index; other engine errors, such as a `uniqhash` violation, pass through
unchanged. Subclasses: `DuplicateIdError` (`id`),
`ValidationError`, `HybridDBCrashedError`, and `UndoConflictError`. Other codes:
`WRITES_DISALLOWED`, `TRANSACTION_FINISHED`, `READONLY_TRANSACTION`,
`TABLE_NOT_FOUND`, `INDEX_NOT_FOUND`, `ASYNC_IN_SYNC_EXECUTION`,
`UNSUPPORTED_COMMAND`, `PERSISTENCE_QUEUE_FULL`, and `DB_CLOSED`. HyperDB does
not log errors it throws.

`await execAsync(db.close())` (or `execSync` for sync runtimes) flushes hybrid
persistence, closes wrapped databases and driver-owned resources, clears
`SubscribableDB` subscribers, and unregisters the DB from devtools. Caller-owned
SQLite handles stay open. Hybrid runtimes refuse new commits as soon as
`close()` starts and wait for accepted ones. Later operations, including cached
selector reads, throw `DB_CLOSED`; a failed `close()` can be retried.

## Undo And Redo

```ts
import { undoMiddleware, withoutUndo } from "@will-be-done/hyperdb/undo";

const history = undoMiddleware(db, {
  tables: [tasksTable], // columns marked with .with(undoIgnore()) are never undone
  skip: (traits) => traits.some((t) => t.type === "remote-merge"),
  maxUndoLevels: 100,
});
const event = execSync(history.undo()); // replayed step; throws when empty
await execAsync(history.redo()); // asynchronous runtime

function* edit() {
  yield* history.withoutUndo(function* () {
    yield* upsert(tasksTable, [task]); // skip this manager
  });
  yield* withoutUndo(function* () {
    yield* upsert(tasksTable, [otherTask]); // skip every manager
  });
}
```

One committed transaction is one step. `undo()` / `redo()` manage their own
transactions: execute them outside actions with `execSync` / `execAsync`.
Use `history.withoutUndo(scopedDb => ...)` or
`withoutUndo(db, scopedDb => ...)` outside actions; dispatch through `scopedDb`.
No global recording flag or stop/resume pairing is needed.

The manager has read-only queues and `store`, levels, `canUndo` / `canRedo`,
`dropUndo` / `dropRedo` (discard the next step), `clearUndo` / `clearRedo`, `subscribe`, `getRevision`, and `dispose`.
`withGroup(name?, scopedDb => ...)` groups synchronous dispatches;
`createGroup(name?)` provides synchronous `continue(scopedDb => ...)` blocks
and `end()`. Groups affect history, not transaction atomicity. An intervening
recorded transaction closes a manual group; no async group-flow API exists.

Choose domain tables; let hooks rebuild untracked derived tables.
`isUndoReplay(traits)` identifies replay in mutation hooks. Replay is excluded
from every manager. Updates replay field by field: they restore and check only
the fields they wrote. Creates and deletes compare whole rows. Conflicts throw
`UndoConflictError` and roll back without moving either queue. Columns annotated
with `undoIgnore()` are never recorded, restored, or checked. `skip(traits)` excludes writes by
trait. History is in memory, with optional
`maxUndoLevels` / `maxRedoLevels`; recorded edits clear redo. Groups clear redo
only when finalized with effective changes; groups with no net changes preserve
it. Binary conflicts compare view types as well as bytes. `HybridDB` background
persistence can fail after the cache commit and history queue movement.

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
transactional schema reconciliation, which rebuilds any index whose columns,
uniqueness, or sort order changed. Table names that differ only in case are
rejected. One transaction runs at a time: while it is open, `SqlDriver` rejects
other driver operations and `AsyncSqlDriver` queues them. Readonly SQLite
transactions reject writes with `READONLY_TRANSACTION`.

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
`byIds` B-tree or call `preloadTables` for this runtime. Reads hydrate missing
rows asynchronously. Transactions publish copy-on-write index and row changes
before queued persistence. Cached `asyncDispatch` work runs before the call
returns its promise. Execution suspends only for database I/O or a busy
transaction lock; handlers cannot await other promises, so fetch outside the
action and pass results in as args.
Both hybrid runtimes allow at most 100 unsettled persistence batches. At
capacity, a transaction rejects before publishing memory changes; await
`waitForPersistence()` and retry in a new transaction. A rejected HybridDB commit
finishes the transaction; further commits throw, and rollback remains safe.
Await `execAsync(db.waitForPersistence())` on either hybrid runtime or its
`SubscribableDB` wrapper before broadcasting changes or acknowledging sync.
The wait covers transactions committed before the call. Permanent persistence
failure rejects the wait and blocks further reads and writes with
`HybridDBCrashedError`.
Exact `byId` misses check the primary so rows added by another connected runtime
can be discovered and incorporated into the preloaded indexes.
For a changeset already persisted by another runtime sharing the primary, run
its merge with `externalStorageMergeTrait` and the app's change-tracking
suppression trait. The merge then updates the preloaded snapshot through normal
transaction operations, subscribers receive normal invalidations, and an
external insert is persisted idempotently rather than failing as a duplicate.
Ordinary inserts retain duplicate-ID checking when applied to storage, including
rows inserted concurrently by another runtime.

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

## Traits

`db.withTraits(trait)` tags writes (for example with their origin). Actions read
them with `yield* getCurrentTraits()`; mutation hooks and `subscribe` callbacks
receive them as an argument. These lists contain only user and plugin traits,
never HyperDB's internal tracing context.

## Typed Yields

Selector handlers may yield only reads (`selectFrom`, other selectors,
`getCurrentTraits`, `noop`); writes or actions inside a selector are type
errors. Action handlers may also yield `insert`, `upsert`, `deleteRows`, other
actions, and `withoutUndo` scopes. Annotate reusable helpers as
`SelectorGenerator<T>` (reads) or `ActionGenerator<T>` (may write), never
`Generator<unknown, T>`. The yield unions are `SelectorCommand` and
`ActionCommand`.

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
