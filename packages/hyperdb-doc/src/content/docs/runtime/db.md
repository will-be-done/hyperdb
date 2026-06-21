---
title: The DB Runtime
description: DB, SubscribableDB — runtime options, transactions, lifecycle hooks, and traits.
sidebar:
  order: 1
---

The runtime ties tables to a [storage driver](/runtime/drivers/) and executes
commands. There are three runtime classes; you almost always use the first two
together.

## `DB`

`DB` is the core runtime. You construct it with a driver and optional settings,
then load your tables.

```ts
import { DB, hyperDBTraceStore } from "@will-be-done/hyperdb-lib";
import { BptreeInmemDriver } from "@will-be-done/hyperdb-lib/drivers/inmemory";

const baseDb = new DB(new BptreeInmemDriver(), {
  runtimeValidation: true,
  freezeArgs: true,
  freezeRows: false,
  tracer: hyperDBTraceStore,
});

baseDb.loadTables([tasksTable]);
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `runtimeValidation` | `false` | Validate full records against their table validators on writes and on reads from the driver |
| `freezeArgs` | `false` | Deep-freeze selector args used by cached selectors/runs |
| `freezeRows` | `false` | Deep-freeze rows after write normalization |
| `traits` | `[]` | Initial [metadata traits](#traits) attached to the DB |
| `tracer` | global default | Per-DB tracer — an instance, `"default"`, or `"disabled"` (see [Devtools & Tracing](/integrations/devtools/)) |
| `dbName` | — | A name used by tracing/devtools to label this database |

`runtimeValidation` is invaluable in development: it catches schema mismatches at
the boundary instead of letting bad data into storage. `freezeArgs` / `freezeRows`
help surface accidental mutation of cached data.

## `SubscribableDB`

`SubscribableDB` **wraps a `DB`** and adds everything reactivity needs:
revisions, subscriptions, and lifecycle hooks. Wrap your base `DB` in it for any
app that renders from the data.

```ts
import { DB, SubscribableDB } from "@will-be-done/hyperdb-lib";

const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
db.loadTables([tasksTable]);
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

You can run extra commands **inside the same transaction** whenever rows change.
Each hook is a generator and may itself read and write. This is how the
[sync engine](/guides/sync-engine/) records change-tracking rows alongside every
mutation.

```ts
const off = db.afterChange(function* (db, table, traits, ops) {
  // runs for every insert/upsert/delete, within the committing transaction
});

db.afterInsert(function* (db, table, traits, ops) { /* InsertOp[] */ });
db.afterUpsert(function* (db, table, traits, ops) { /* UpsertOp[] */ });
db.afterDelete(function* (db, table, traits, ops) { /* DeleteOp[] */ });
```

`InsertOp` / `UpsertOp` / `DeleteOp` carry the affected rows (upserts and deletes
include the previous value), so a hook has everything it needs to derive a diff.

Because hooks run **within** the transaction, anything they write commits
atomically with the change that triggered them — and a throw rolls the whole
thing back.


## Executing commands

Selectors and actions are generators. The dispatch and select helpers run them
for you, but you can also drive a generator directly:

| Helper | Use |
| --- | --- |
| `syncDispatch(db, action(args))` | Run an action in a transaction (sync drivers) |
| `asyncDispatch(db, action(args))` | Run an action in a transaction (async drivers) |
| `select(db, gen)` | Run a selector once (sync drivers) |
| `runSelectorAsync(db, () => gen)` | Run a selector once (async drivers) |
| `execSync(generator)` | Drive a raw DB-command generator (sync) |
| `execAsync(generator)` | Drive a raw DB-command generator (async) |

`execSync` throws if the generator yields an async command, which is how the
sync/async split is enforced. Async drivers must go through `execAsync` /
`asyncDispatch` / `runSelectorAsync`.

## Traits

**Traits** are arbitrary metadata you attach to a DB or a transaction; they flow
through to hooks and the tracer. Derive a DB view that carries extra traits with
`withTraits`, and read the current set inside an action with `getCurrentTraits`.

```ts
import { getCurrentTraits } from "@will-be-done/hyperdb-lib";

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
