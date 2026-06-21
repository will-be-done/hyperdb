---
title: Building a Sync Engine
description: A worked example — change tracking, CRDT-style merge, and a two-tier persistent setup built on HyperDB primitives.
sidebar:
  order: 2
---

HyperDB has no built-in network layer, but it gives you exactly the primitives a
sync engine needs: **transactional actions**, **lifecycle hooks** that run inside
the committing transaction, **traits** to tag the origin of a write, and
**multiple databases** wired together. This guide walks through a real local-first
sync design built entirely on those primitives.

The pieces are:

1. A **change-tracking table** that records what changed and when.
2. **Lifecycle hooks** that append change records on every mutation.
3. **Merge actions** that apply remote changesets with last-write-wins semantics.
4. A **two-tier runtime** — an in-memory tier for the UI, a persistent tier for
   durability — plus the glue that hydrates, persists, and syncs.

## 1. The change-tracking table

Every syncable entity gets a companion row in a `changes` table. Crucially, the
`changes` field is a `record(string, string)` mapping **each column name to the
logical clock at which it last changed** — that per-field timestamp is what makes
field-level last-write-wins possible.

```ts
import { defineTable, type ExtractSchema, v } from "@will-be-done/hyperdb-lib";

export const changesTable = defineTable("changes", {
  id: v.string(),
  entityId: v.string(),
  tableName: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
  deletedAt: v.union(v.string(), v.null()),
  clientId: v.string(),
  changes: v.record(v.string(), v.string()), // column -> clock
})
  .index("byEntityId", ["entityId"], { type: "hash" })
  .index("byEntityIdAndTableName", ["entityId", "tableName"])
  .index("byUpdatedAt", ["updatedAt"]);

export type Change = ExtractSchema<typeof changesTable>;
```

The `byUpdatedAt` B-tree index makes "everything that changed after clock _X_" a
single range query — the basis of outgoing sync:

```ts
const allChangesAfter = selector({
  name: "allChangesAfter",
  args: { after: v.string() },
  handler: function* ({ after }) {
    return (yield* selectFrom(changesTable, "byUpdatedAt")
      .where((q) => q.gt("updatedAt", after))) as Change[];
  },
});
```

## 2. Recording changes with hooks

Instead of asking every action to also write a change row, register
[lifecycle hooks](/runtime/db/#lifecycle-hooks) on the `SubscribableDB`. They run
**inside the same transaction** as the originating write, so a change record can
never be lost or get out of step with the data.

```ts
import { noop, syncDispatch } from "@will-be-done/hyperdb-lib";

syncSubDb.afterInsert(function* (db, table, traits, ops) {
  if (table === changesTable) return;                 // don't track the tracker
  if (traits.some((t) => t.type === "skip-sync")) return; // see "traits" below

  for (const op of ops) {
    syncDispatch(
      db,
      insertChangeFromInsert({
        tableDef: op.table,
        row: op.newValue,
        clientId,
        nextClock: nextClock(),
      }),
    );
  }
  yield* noop();
});
```

Two HyperDB features make this clean:

- **`op.oldValue` / `op.newValue`** on upsert ops let the update hook diff old vs.
  new and stamp only the columns that actually changed.
- **Traits** let a write opt out of tracking. When the engine applies remote
  changes it tags the transaction with a `skip-sync` trait, and the hook sees it
  via its `traits` argument and returns early — so applying a remote change
  doesn't generate a new outgoing change and loop forever.

`noop()` is a do-nothing command; hooks are generators, so yielding it satisfies
the generator contract while keeping the hook compatible with both sync and async
execution.

The update hook stamps changed columns with the current clock:

```ts
export const insertChangeFromUpdate = action({
  name: "insertChangeFromUpdate",
  args: { /* tableDef, oldRow, newRow, clientId, nextClock */ },
  handler: function* ({ tableDef, oldRow, newRow, clientId, nextClock }) {
    const change = (yield* getChangeByEntityAndTableName({
      entityId: oldRow.id,
      tableName: tableDef.tableName,
    })) ?? freshChange(oldRow, tableDef, clientId, nextClock);

    const changedCols = change.changes;
    for (const col of uniq([...Object.keys(oldRow), ...Object.keys(newRow)])) {
      if (!isEqual(oldRow[col], newRow[col])) changedCols[col] = nextClock;
    }
    // ...write the updated change row with upsert
  },
});
```

## 3. Merging remote changesets

Applying changes from another client is itself just an **action**. For each
incoming entity the engine reads the local change row and local data row (batched
with array-form `where` queries), then merges:

- **Field-level last-write-wins.** For every column, compare the local clock with
  the incoming clock; the higher clock's value wins.
- **First-creator-wins on conflicting creates.** If both sides created the same
  id independently, the earlier `createdAt` wins as the base.
- **Delete-wins.** A tombstone (`deletedAt` set) beats a concurrent edit.

The merged rows are written back with bulk `insert` / `upsert` / `deleteRows`, and
the recomputed change rows with `upsert` — all in one transaction:

```ts
export const mergeChanges = action({
  name: "mergeChangesAction",
  args: { /* input, nextClock, clientId, registeredSyncableTableNameMap */ },
  handler: function* ({ input, nextClock, registeredSyncableTableNameMap }) {
    for (const changeset of input) {
      const table = registeredSyncableTableNameMap[changeset.tableName];
      // batched reads of current changes + rows...
      // per-entity LWW / first-creator-wins / delete-wins merge...
      yield* insert(table, toInsertRows);
      yield* upsert(table, toUpdateRows);
      yield* deleteRows(table, toDeleteRows);
    }
    yield* upsert(changesTable, allChanges);
  },
});
```

To keep individual index scans bounded, large batches are **chunked** (e.g. 400
ids per `where` array) — a good habit for any bulk read/write.

## 4. The two-tier runtime

For responsiveness, the UI reads and writes an **in-memory** database, while a
**persistent** database (IndexedDB or async SQLite) provides durability. On
startup the in-memory tier is hydrated from the persistent one; afterwards writes
flow back out asynchronously. The
[In-Memory + Persistence guide](/guides/in-memory-persistence/) builds this
two-tier setup on its own, without the sync machinery — start there if you only
need durable local storage; the change tracking below layers on top of it.

This is what wiring it all together looks like (condensed from a real app):

```ts
export const initDbStore = async (syncConfig: SyncConfig): Promise<SubscribableDB> => {
  // in-memory `syncDB` for the UI; persistent `persistentDB`; `syncSubDb` wraps the in-memory DB
  const { persistentDB, syncDB, syncSubDb } = await createStoreDbs(dbName, syncConfig);

  // 1. change-tracking hooks on the in-memory subscribable DB
  registerSyncChangeHooks({ syncSubDb, clientId, nextClock });

  // 2. load persisted rows into the in-memory tier
  await hydrateSyncDb({ persistentDB, syncDB, syncableDBTables: syncConfig.syncableDBTables });

  // 3. cross-tab + server sync, and a queue that flushes the in-memory tier to disk
  const crossTabChanges = createCrossTabChanges({ clientId, syncSubDb, syncConfig, nextClock });
  const syncer = new Syncer(persistentDB, clientId, syncConfig, nextClock, crossTabChanges.applyChanges);
  const localPersistQueue = createLocalPersistQueue({
    clientId, persistentDB, syncSubDb, nextClock,
    postChanges: crossTabChanges.postChanges,
    onPersisted: () => syncer.forceSync(),
  });
  localPersistQueue.start();

  if (!syncConfig.disableSync) syncer.startLoop();
  return syncSubDb;
};
```

The flow at runtime:

1. The UI dispatches an action against `syncSubDb` (the in-memory tier).
2. The `afterChange`-family hooks record change rows in the same transaction.
3. The local persist queue observes the commit and flushes the affected rows and
   change rows to the persistent tier.
4. The syncer ships outgoing changes (via the `byUpdatedAt` range query) and feeds
   incoming changesets to `mergeChanges`, tagging that transaction with the
   `skip-sync` trait so it isn't re-tracked.

## The server is just another peer

Because HyperDB runs the same code everywhere, the **server** uses the exact same
`changesTable`, `insertChangeFrom*` actions, and `afterInsert`/`afterUpsert`/
`afterDelete` hooks as every browser client — imported from the same shared
slice. The only differences are the driver ([native SQLite](/runtime/drivers/#backend-native-sqlite))
and the `clientId` (e.g. `"server-<dbName>"`).

```ts
import { Database } from "bun:sqlite";
import { SqlDriver } from "@will-be-done/hyperdb-lib/drivers/sqlite";
import { DB, SubscribableDB, syncDispatch, noop } from "@will-be-done/hyperdb-lib";
import {
  changesTable,
  insertChangeFromInsert,
  insertChangeFromUpdate,
  insertChangeFromDelete,
} from "@will-be-done/slices/common"; // ← same slice the client imports

const hyperDB = new SubscribableDB(new DB(makeBunSqliteDriver("space-42.sqlite")));
const clientId = "server-space-42";

// identical to the browser's registerSyncChangeHooks
hyperDB.afterInsert(function* (db, table, traits, ops) {
  if (table === changesTable) return;
  if (traits.some((t) => t.type === "skip-sync")) return;
  for (const op of ops) {
    syncDispatch(db, insertChangeFromInsert({
      tableDef: op.table, row: op.newValue, clientId, nextClock: nextClock(),
    }));
  }
  yield* noop();
});
// ...afterUpsert / afterDelete are the same as on the client
```

The server merges incoming changesets with the same `mergeChanges` action and
ships its own changes back with the same `getChangesetAfter` selector. There is no
separate "server schema" or "server query language" — the data layer is written
once and shared.

## What HyperDB provided

Everything above is application code — but it leans entirely on built-in
primitives:

| Need | HyperDB feature |
| --- | --- |
| Atomic data + bookkeeping | [Transactional dispatch](/database/writing-data/#transactions) |
| React to every mutation in-band | [`afterInsert`/`afterUpsert`/`afterDelete`/`afterChange`](/runtime/db/#lifecycle-hooks) |
| Diff a write | `oldValue`/`newValue` on ops |
| Tag a write's origin | [Traits](/runtime/db/#traits) |
| "What changed after X?" | A [B-tree range query](/database/indexes/) on `updatedAt` |
| Batched reads/writes | Array-form `where` + array mutations |
| Fast UI + durable storage | Two [DBs](/runtime/db/) with different [drivers](/runtime/drivers/) |
| Same logic on client & server | One schema + actions, swap only the [driver](/runtime/drivers/#backend-native-sqlite) |

You supply the merge policy and the transport; HyperDB supplies the reactive,
transactional, indexed store underneath.
