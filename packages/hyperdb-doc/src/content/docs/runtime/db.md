---
title: The DB Runtime
description: DB, SubscribableDB, HybridDB, transactions, lifecycle hooks, and traits.
sidebar:
  order: 1
---

The runtime ties tables to a [storage driver](/runtime/drivers/) and executes
commands.

## Which runtime should I use?

| Runtime shape                   | Use when                                                                                   | Tradeoff                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`                            | You only need `selectSync`, `insert`, `upsert`, `deleteRows`, and transactions.            | Lowest overhead. No subscriptions, reactive selector cache, revisions, or lifecycle hooks.                                                                                                                                                   |
| `SubscribableDB` + sync driver  | Your reactive app can load its working state into memory.                                  | Best interactive path: selectors and actions can stay synchronous with `useSyncSelector`, `useSyncDispatch`, `selectSync`, and `syncDispatch`.                                                                                               |
| `SubscribableDB` + async driver | Your reactive app should keep memory low and read directly from IndexedDB or async SQLite. | Uses async selectors/actions. Simpler than `HybridDB`, but every read follows the async driver path.                                                                                                                                         |
| `SubscribableDB` + `HybridDB`   | Local-first browser apps that want persistent storage plus fast reads for hot data.        | Uses async APIs, but reads check the in-memory cache first. Missing index ranges fall through to the primary store, then get cached for next time. Writes update the cache first for immediate UI response, then flush to the primary store. |

## `DB`

`DB` is the core runtime. You construct it with a driver and optional settings,
then load your tables.

```ts
import { DB, execSync, hyperDBTraceStore } from "@will-be-done/hyperdb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";

const baseDb = new DB(new BptreeInmemDriver(), {
  runtimeRowsValidation: process.env.NODE_ENV === "development",
  freezeArgs: process.env.NODE_ENV === "development",
  freezeRows: process.env.NODE_ENV === "development",
  tracer: hyperDBTraceStore,
});

execSync(baseDb.loadTables([tasksTable]));
```

### Options

| Option                  | Default        | Description                                                                                                  |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `runtimeRowsValidation` | `false`        | Validate full records against their table validators on writes and on reads from the driver                  |
| `freezeArgs`            | `false`        | Deep-freeze selector args used by cached selectors/runs                                                      |
| `freezeRows`            | `false`        | Deep-freeze rows after write normalization                                                                   |
| `register`              | `true`         | Automatically register the DB with the runtime registry for tracing/devtools discovery                       |
| `traits`                | `[]`           | Initial [metadata traits](#traits) attached to the DB                                                        |
| `tracer`                | global default | Per-DB tracer: an instance, `"default"`, or `"disabled"` (see [Devtools & Tracing](/integrations/devtools/)) |
| `dbName`                | none           | A name used by tracing/devtools to label this database                                                       |

`runtimeRowsValidation` is useful in development because it catches schema
mismatches at the boundary instead of letting bad data into storage.
`freezeArgs` / `freezeRows` help surface accidental mutation of cached data.

## `SubscribableDB`

`SubscribableDB` wraps a runtime such as `DB` or `HybridDB` and adds the pieces
reactivity uses: revisions, subscriptions, and lifecycle hooks. Wrap your app
runtime in it for any UI that renders from the data.

```ts
import { DB, SubscribableDB, execSync } from "@will-be-done/hyperdb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";

const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
execSync(db.loadTables([tasksTable]));
```

### Subscriptions and revisions

Every committed transaction increments a revision and notifies subscribers with
the operations it performed:

```ts
db.getRevision(); // current revision number

const unsub = db.subscribe((ops, traits, revision) => {
  // ops describe the committed insert/upsert/delete operations
});
```

This is the mechanism the [selector cache](/database/reading-data/) uses.

### Lifecycle hooks

You can run extra commands from lifecycle hooks. Mutation hooks run inside the
same transaction as the change that triggered them. Scan hooks run after a
successful index scan, and if that scan is inside a transaction, commands yielded
by the hook use that same transaction.

```ts
const off = db.afterChange(function* (db, table, traits, ops) {
  // runs for every insert/upsert/delete, within the committing transaction
});

db.afterInsert(function* (db, table, traits, ops) {
  /* InsertOp[] */
});
db.afterUpsert(function* (db, table, traits, ops) {
  /* UpsertOp[] */
});
db.afterDelete(function* (db, table, traits, ops) {
  /* DeleteOp[] */
});

db.afterScan(function* (db, table, indexName, clauses, selectOptions, results) {
  // runs after a successful intervalScan/selectFrom scan
});
```

`InsertOp` / `UpsertOp` / `DeleteOp` carry the affected rows (upserts and deletes
include the previous value), so a hook has everything it needs to derive a diff.
`afterScan` receives the table, index name, where clauses, select options, and
the returned rows.

Because mutation hooks run within the transaction, anything they write commits
atomically with the change that triggered them, and a throw rolls the whole
thing back. An `afterScan` throw fails the scan that triggered it.

## `HybridDB`

`HybridDB` combines a primary store with an in-memory B-tree cache. In a browser
app, the primary store is usually IndexedDB or async SQLite. Reads use the cache
when an index range is already covered, and fall through to the primary store on
cache misses. Writes update the cache first for an immediate UI response, then
flush to the primary store in order.

Use `HybridDB` when you want persistent local state without loading the whole
dataset into memory on startup. If your whole app state can be loaded eagerly,
a plain `SubscribableDB(new DB(new BptreeInmemDriver()))` keeps reads and writes
synchronous and avoids cache-miss promises.

```ts
import { DB, HybridDB, SubscribableDB, execAsync } from "@will-be-done/hyperdb";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";

const primary = new DB(await openIndexedDBDriver("my-app"), {
  runtimeRowsValidation: process.env.NODE_ENV === "development",
  freezeArgs: process.env.NODE_ENV === "development",
  freezeRows: process.env.NODE_ENV === "development",
});
const cache = new DB(new BptreeInmemDriver());

const hybrid = new HybridDB(primary, cache);
const db = new SubscribableDB(hybrid);

await execAsync(db.loadTables([tasksTable, projectsTable]));
await execAsync(
  db.preloadTables([
    { table: tasksTable, scanIndex: "byIds" },
    { table: projectsTable, scanIndex: "byIds" },
  ]),
);
```

The trade-off is async reads. A selector may miss memory and read from the
primary store, so use `selectAsync`, `asyncDispatch`, `useAsyncSelector`, and
`useAsyncDispatch` with a hybrid runtime. Once a working set is cached, repeated
reads are served from the in-memory tier.

### Read Path

On read, `HybridDB` checks the in-memory cache first. If only part of the
requested index range is cached, it reads cached rows from memory, loads the
uncovered portions from the primary store, merges the rows in index order, and
records the newly loaded ranges as cached for later reads. Empty misses are
cached too.

Limited B-tree reads cache the covered prefix or suffix when the runtime can
prove the returned rows are enough to answer the same limited query from memory.
Rows loaded by any primary-store scan also mark their exact `uniqhash` values as
cached, because those values are driver-enforced unique. That means a later
exact lookup on `byId` or another `uniqhash` index can hit memory even if the
row was first loaded through a different index.

With an IndexedDB primary, no readonly IndexedDB transaction is opened until a
selector actually misses the cache. If the primary store is read, readonly
transaction reuse stays scoped to that selector run, so concurrent selector runs
do not share one IndexedDB transaction.

### Preloading

Use `preloadTables` when you know a whole table should be resident from startup
or before a workflow begins. `scanIndex` must be a B-tree index that can scan the
whole table, commonly an explicit `.index("byIds", ["id"])`; the built-in
`byId` index is a `uniqhash` index for exact id lookups, not full-table scans.

After a table preload finishes, HybridDB marks that table's index ranges as
cached, so later selectors over other indexes can read from memory.
`preloadTables` is part of the `HyperDB` contract and is safe to call through
wrappers such as `SubscribableDB`; DBs that do not have a preload layer
implement it as a no-op.

### Write Path

Writes outside a transaction go to both tiers in the same operation. Readwrite
transactions are optimistic: writes apply to the in-memory cache transaction
first, commit the cache, publish subscribers, and then flush the final row
changes to the primary store in a queued background transaction. Persistent
flushes are serialized so the primary sees committed cache transactions in
order.

The flush uses `upsert` for inserted and updated rows, so repeated persistence
attempts can safely write the latest row value. If a background flush fails,
HybridDB retries it with bounded backoff before giving up. While it is
unresolved, scans and root operations that need that batch continue to wait on
the queued flush.

If the retry limit is reached, the cache and primary store can no longer be
trusted to agree, so HybridDB enters a permanent **crashed** state. Every
subsequent read, write, or transaction, including cache-only reads, throws
`HybridDBCrashedError` with the persistence error as its `cause`. Check
`hybrid.isCrashed` to detect this; recover by constructing a fresh `HybridDB`
and reloading tables or by reloading the browser.

### Pending Flushes

While a persistent flush is pending, cached scan intervals still read from the
in-memory cache immediately. Those cached reads see the committed cache state,
including rows changed by the write that is still flushing to the primary store.

If a scan will read from the primary store, HybridDB checks pending writes for
that table against only the uncovered portion that the primary will read. For
each pending write, the **old** row is the row before the mutation, when HybridDB
knew it from cache. The **new** row is the row after the mutation; deletes have
no new row. If the old row is known and neither the old nor new row belongs to
the primary-read interval, the scan can read the primary store immediately. If
the row may affect that interval, or the old row is unknown, HybridDB waits for
the flush first so the primary scan cannot return stale results.

Exact unique lookups are the exception to broad equality waits. After a cache
transaction commits, HybridDB marks exact `uniqhash` intervals as covered for
the known old and new values. The built-in `byId` lookup is covered by id even
when a delete did not know the old row. That lets exact unique reads return from
memory while broader uncached scans still wait when a pending write could affect
their interval.

## Executing commands

Selectors and actions are generators. The dispatch and select helpers run them
for you, but you can also drive a generator directly:

| Helper                                | Use                                            |
| ------------------------------------- | ---------------------------------------------- |
| `syncDispatch(db, action(args))`      | Run an action in a transaction (sync drivers)  |
| `asyncDispatch(db, action(args))`     | Run an action in a transaction (async drivers) |
| `selectSync(db, { selector, args })`  | Run a selector once (sync drivers)             |
| `selectAsync(db, { selector, args })` | Run a selector once (async drivers)            |
| `execSync(generator)`                 | Drive a raw DB-command generator (sync)        |
| `execAsync(generator)`                | Drive a raw DB-command generator (async)       |

`execSync` throws if the generator yields an async command, which is how the
sync/async split is enforced. Async drivers must go through `execAsync` /
`asyncDispatch` / `selectAsync`. Use the async helpers with `HybridDB` too,
because reads can miss the in-memory cache and fall through to the primary
store.

## Traits

Traits are arbitrary metadata you attach to a DB or a transaction; they flow
through to hooks and the tracer. Derive a DB view that carries extra traits with
`withTraits`, and read the current set inside an action with `getCurrentTraits`.

```ts
import { getCurrentTraits } from "@will-be-done/hyperdb";

const scopedDb = db.withTraits({ type: "myFeature.source", value: "import" });

const whoami = action({
  name: "whoami",
  args: {},
  handler: function* () {
    const traits = yield* getCurrentTraits();
    return traits;
  },
});
```

A typical use is tagging writes with their origin (e.g. "local edit" vs. "applied
from sync") so an `afterChange` hook can decide whether to record them.
