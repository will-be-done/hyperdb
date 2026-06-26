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

You can run extra commands inside the same transaction whenever rows change.
Each hook is a generator and may itself read and write. This is how the
[sync engine](/guides/sync-engine/) records change-tracking rows alongside every
mutation.

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
```

`InsertOp` / `UpsertOp` / `DeleteOp` carry the affected rows (upserts and deletes
include the previous value), so a hook has everything it needs to derive a diff.

Because hooks run within the transaction, anything they write commits
atomically with the change that triggered them, and a throw rolls the whole
thing back.

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

const db = new SubscribableDB(new HybridDB(primary, cache));

await execAsync(db.loadTables([tasksTable]));
```

The trade-off is async reads. A selector may fall through to disk, so use
`selectAsync`, `asyncDispatch`, `useAsyncSelector`, and `useAsyncDispatch` with a
hybrid runtime. Once a working set is cached, repeated reads are served from the
in-memory tier.

Writes go to both tiers in the same operation. That means cached rows stay
current immediately, while uncached ranges still load lazily on first access.
Transactions open transactions against both tiers; scan coverage discovered
inside a transaction is published to the outer cache only after commit.
Drivers explicitly report whether selector-scoped readonly transactions are
supported. When they are, HyperDB uses `beginTx("readonly")`; HybridDB keeps
that context lazy until a selector misses the cache and reads the persistent
tier.

HybridDB serializes cache fills, write-through mutations, coverage updates, and
transaction lifetimes per instance. This keeps async selector misses and actions
from overlapping against the in-memory cache tier while a primary read or
transaction is still in flight.

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
