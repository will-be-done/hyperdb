---
title: The DB Runtime
description: DB and SubscribableDB runtime options, transactions, lifecycle hooks, and traits.
sidebar:
  order: 1
---

The runtime ties tables to a [storage driver](/runtime/drivers/) and executes
commands.

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

`SubscribableDB` wraps a `DB` and adds the pieces reactivity uses: revisions,
subscriptions, and lifecycle hooks. Wrap your base `DB` in it for any app that
renders from the data.

```ts
import { DB, SubscribableDB, execSync } from "@will-be-done/hyperdb";

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

This is the mechanism the [selector cache](/database/selectors-reactivity/) uses.

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

`HybridDB` wraps two DBs: a persistent primary DB and an in-memory cache DB. It
is for datasets that are too large to hydrate eagerly, or apps where startup
time matters more than synchronous reads.

On read, `HybridDB` checks the in-memory cache first. If the requested index
range is not cached, it runs the same scan against the persistent primary,
upserts the returned rows into memory, and records that range as cached for
later reads. Empty misses are cached too. Limited B-tree reads cache the covered
prefix or suffix when the runtime can prove the returned rows are enough to
answer the same limited query from memory. With an IndexedDB primary, this means
no readonly IndexedDB transaction is opened until the selector actually falls
through to the persisted tier. If the persistent tier is read, readonly
transaction reuse stays scoped to that selector run, so concurrent selector runs
do not share one IndexedDB transaction.

```ts
import { DB, HybridDB, SubscribableDB, execAsync } from "@will-be-done/hyperdb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { AsyncSqlDriver } from "@will-be-done/hyperdb/drivers/sqlite";

const primary = new DB(new AsyncSqlDriver(sqlite, sqliteDb));
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

The trade-off is async reads. A selector may fall through to disk, so use
`selectAsync`, `asyncDispatch`, `useAsyncSelector`, and `useAsyncDispatch` with a
hybrid runtime. Once a working set is cached, repeated reads are served from the
in-memory tier.
Use `preloadTables` when you know a whole table should be resident from startup
or before a workflow begins. `scanIndex` must be a B-tree index that can scan the
whole table, commonly an explicit `.index("byIds", ["id"])`; the built-in
`byId` index is a hash index for exact id lookups, not full-table scans. After a
table preload finishes, HybridDB marks that table's index ranges as cached, so
later selectors over other indexes can read from memory. `preloadTables` is part
of the `HyperDB` contract and is safe to call through wrappers such as
`SubscribableDB`; DBs that do not have a preload layer implement it as a no-op.

Writes outside a transaction go to both tiers in the same operation. Readwrite
transactions are optimistic: writes apply to the in-memory cache transaction
first, commit the cache, publish subscribers, and then flush the final row
changes to the persistent primary in a queued background transaction. The flush
uses `upsert` for inserted and updated rows, so repeated persistence attempts
can safely write the latest row value.

While a persistent flush is pending, cached scan intervals still read from the
in-memory cache immediately. If a scan would fall through to the persistent
primary, HybridDB checks the pending old and new row values for that table and
index. The persistent fallback waits only when those pending rows can belong to
the requested interval; unrelated uncached ranges can continue loading lazily.
If an upsert or delete did not have the old row in memory, HybridDB treats that
old position as unknown and waits for the flush before uncached scans of that
table fall through to the primary.

Exact id lookups are the exception to broad equality waits. After a cache
transaction commits, HybridDB marks exact `id` intervals as covered for all
single-column id indexes on rows written by that transaction. That lets
`byId`/`byIds` equality reads return from memory while the persistent flush is
still pending. Equality scans on non-unique values, such as `status = "done"`,
still wait when pending rows can affect the interval unless that interval was
already cached.

Pass `debug: true` to `new HybridDB(primary, cache, { debug: true })` to log
when an uncached scan falls through to persistence or waits for pending
persistence. Pass a callback instead of `true` to receive structured
`HybridDBDebugEvent` objects. `persistent-scan` events include the scan
table/index, clauses, target intervals, cached intervals, uncovered intervals,
and limited cache probe information. `pending-persistence-wait` events include
the pending batch id, row id, and whether the old or new row value matched the
requested interval.

Scan coverage discovered inside a transaction is published to the outer cache
only after the cache transaction commits, but transaction scans can still reuse
coverage that was already known by the committed cache when the transaction
started. Non-transaction reads of the in-memory cache continue to see the last
committed cache snapshot while a write transaction is active; they do not see
uncommitted transaction writes.
Drivers explicitly report whether selector-scoped readonly transactions are
supported. When they are, HyperDB uses `beginTx("readonly")`; HybridDB keeps
that context lazy until a selector misses the cache and reads the persistent
tier. If the browser finishes that readonly transaction between selector scans,
the current scan reopens it once. Selector and action execution context is
carried as a trait so persistent drivers can include run names in their logs.

HybridDB serializes cache fills, coverage updates, cache transaction lifetimes,
and root write-through mutations per instance. Persistent flushes from
readwrite transactions are also serialized so the primary sees committed cache
transactions in order.

## Executing commands

Selectors and actions are generators. The dispatch and select helpers run them
for you, but you can also drive a generator directly:

| Helper                            | Use                                            |
| --------------------------------- | ---------------------------------------------- |
| `syncDispatch(db, action(args))`  | Run an action in a transaction (sync drivers)  |
| `asyncDispatch(db, action(args))` | Run an action in a transaction (async drivers) |
| `select(db, gen)`                 | Run a selector once (sync drivers)             |
| `selectAsync(db, gen)`            | Run a selector once (async drivers)            |
| `execSync(generator)`             | Drive a raw DB-command generator (sync)        |
| `execAsync(generator)`            | Drive a raw DB-command generator (async)       |

`execSync` throws if the generator yields an async command, which is how the
sync/async split is enforced. Async drivers must go through `execAsync` /
`asyncDispatch` / `selectAsync`.

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
