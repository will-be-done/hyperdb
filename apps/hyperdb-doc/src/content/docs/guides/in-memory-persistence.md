---
title: In-Memory Store with Persistence
description: Run a synchronous in-memory HyperDB for the UI and mirror every change to a persistent IndexedDB tier — instant reads and writes that are still durable.
sidebar:
  order: 1
  label: In-Memory + Persistence
---

The fastest local-first setup HyperDB enables is a **two-tier** one: the UI reads
and writes a synchronous **in-memory** database, and every change is mirrored to a
**persistent** database (IndexedDB) in the background. On startup you load the
persisted rows back into memory.

The result is the best of both worlds — selectors and actions stay
[synchronous and instant](/start/why/#synchronous-on-the-frontend) because they
run against the in-memory tier, while your data survives reloads because it's
continuously flushed to disk. This guide builds that setup from scratch.

This is **persistence**, not multi-client sync. If you also need change tracking,
merge, and a server peer, the [Sync Engine guide](/guides/sync-engine/) layers
all of that on top of exactly this foundation.

## The shape

```
        write (sync)                 mirror (async)
  UI ──────────────▶  in-memory DB ──────────────▶  IndexedDB
       read (sync)    (SubscribableDB)   subscribe   (persistent)
                            ▲                              │
                            └───────── hydrate ────────────┘
                                   (load on startup)
```

Three moving parts: **hydrate** on startup, **subscribe** to in-memory commits,
and **persist** each batch of changes to IndexedDB.

## 1. Give each persisted table a full-scan index

To hydrate you need to read *every* row of a table. The built-in `byId` index is
a **hash** index — it can only look up a single id, not scan a whole table. So add
a **btree** index over `id` (here `byIds`) to every table you persist:

```ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb-lib";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  .index("byIds", ["id"]); // btree over id → enables a full-table scan

export type Task = ExtractSchema<typeof tasksTable>;
```

With a btree index, `selectFrom(table, "byIds")` with no `where` returns the whole
table — that's what hydration reads.

## 2. Create both databases

The in-memory tier is a [`SubscribableDB`](/runtime/db/) over the
[in-memory driver](/runtime/drivers/#in-memory) (synchronous). The persistent
tier is a plain [`DB`](/runtime/db/) over the
[IndexedDB driver](/runtime/drivers/#indexeddb) (asynchronous), so its
`loadTables` runs through `execAsync`.

```ts
import { BptreeInmemDriver } from "@will-be-done/hyperdb-lib/drivers/inmemory";
import { openIndexedDBDriver } from "@will-be-done/hyperdb-lib/drivers/idb";
import { DB, SubscribableDB, execAsync } from "@will-be-done/hyperdb-lib";
import { tasksTable, projectsTable } from "./tables";

const persistedTables = [tasksTable, projectsTable];

export async function createStores(dbName: string) {
  // Persistent tier — IndexedDB, async
  const persistentDB = new DB(await openIndexedDBDriver(dbName));
  await execAsync(persistentDB.loadTables(persistedTables));

  // In-memory tier — synchronous; this is what the UI reads and writes
  const memDB = new SubscribableDB(new DB(new BptreeInmemDriver()));
  memDB.loadTables(persistedTables);

  return { persistentDB, memDB };
}
```

Both tiers load the **same table definitions** — the only difference is the
driver underneath.

## 3. Hydrate the in-memory tier

On startup, read every row from the persistent tier and insert it into memory.
Reads from IndexedDB are async (`runSelectorAsync`); the insert into memory is sync
(`syncDispatch`).

```ts
import {
  insert,
  runSelectorAsync,
  selectFrom,
  syncDispatch,
  type HyperDB,
  type SubscribableDB,
  type TableDefinition,
} from "@will-be-done/hyperdb-lib";

async function hydrate(
  persistentDB: HyperDB,
  memDB: SubscribableDB,
  tables: TableDefinition[],
) {
  for (const table of tables) {
    // Full-table scan over the `byIds` btree index (no `where`)
    const rows = await runSelectorAsync(persistentDB, function* () {
      return yield* selectFrom(table, "byIds").order("asc");
    });

    // Load them into the in-memory tier in a single transaction
    syncDispatch(memDB, insert(table, rows));
  }
}
```

After `hydrate` returns, the in-memory tier holds a complete copy of your data and
the UI can read it synchronously.

:::caution
Hydration loads the **whole dataset into memory**. That's exactly right for a
local-first client (one user's data), but it's the opposite of the
[server pattern](/start/why/#the-backend-problem), where the runtime pulls in only
the rows a selector touches. Don't hydrate an unbounded server table this way.
:::

:::note[Load on demand: a hybrid mode (in development)]
Eager hydration is the simplest model, but not the only one. A **hybrid** mode —
in development — flips it around: instead of loading everything up front, a read
checks the in-memory tier first and, on a miss, runs the *same* query against the
persistent tier and caches the result back into memory for next time.

The trade-off is that selectors and dispatch become **async** (a read may need to
fall through to disk), but startup is near-instant and memory stays low, because
data is pulled in **lazily, on demand**. Writes still commit instantly for any
rows already cached — so if you preload the working set, actions stay synchronous
while everything else loads on first access. This guide uses the eager model;
reach for hybrid mode when the dataset is too large to hold fully in memory or
when startup time matters more than synchronous reads.
:::

## 4. Mirror every change to disk

Subscribe to the in-memory `SubscribableDB`. Each committed transaction hands you
the list of [`Op`s](/database/selectors-reactivity/#subscriptions-and-revisions)
(`insert` / `upsert` / `delete`, each carrying the affected rows). Queue them and
apply them to the persistent tier.

Because IndexedDB is async while commits arrive synchronously, a small queue
**serializes** the writes so batches are persisted in commit order, one
transaction at a time.

```ts
import { execAsync, type HyperDB, type Op, type SubscribableDB } from "@will-be-done/hyperdb-lib";

export function startPersisting(persistentDB: HyperDB, memDB: SubscribableDB) {
  const pending: Op[][] = [];
  let draining = false;

  async function persistBatch(ops: Op[]) {
    const tx = await execAsync(persistentDB.beginTx());
    let committed = false;
    try {
      for (const op of ops) {
        if (op.type === "insert") {
          await execAsync(tx.insert(op.table, [op.newValue]));
        } else if (op.type === "upsert") {
          await execAsync(tx.upsert(op.table, [op.newValue]));
        } else {
          await execAsync(tx.delete(op.table, [op.oldValue.id]));
        }
      }
      await execAsync(tx.commit());
      committed = true;
    } finally {
      if (!committed) await execAsync(tx.rollback());
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const batch = pending.shift()!;
        try {
          await persistBatch(batch);
        } catch (err) {
          console.error("Failed to persist batch", err);
        }
      }
    } finally {
      draining = false;
    }
  }

  // Every in-memory commit becomes one batch to flush
  const unsubscribe = memDB.subscribe((ops) => {
    pending.push([...ops]);
    void drain();
  });

  // Best-effort flush of anything still queued when the tab goes away
  const flush = () => void drain();
  window.addEventListener("pagehide", flush, { capture: true });
  window.addEventListener("beforeunload", flush, { capture: true });

  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush, { capture: true });
    window.removeEventListener("beforeunload", flush, { capture: true });
  };
}
```

The `tx.insert` / `tx.upsert` / `tx.delete` methods apply each op to the open
transaction; committing flushes the whole batch atomically, and any failure rolls
it back.

## 5. Wire it together

```ts
import { createStores } from "./stores";

export async function initStore(dbName: string) {
  const { persistentDB, memDB } = await createStores(dbName);

  await hydrate(persistentDB, memDB, persistedTables);
  startPersisting(persistentDB, memDB);

  // Hand the in-memory tier to the app — pass it to <DBProvider value={memDB}>
  return memDB;
}
```

From here, the app only ever talks to `memDB`: reads via
[`useSyncSelector`](/integrations/react/), writes via
[`useDispatch`](/integrations/react/). Both are synchronous and instant; the
persistence loop keeps disk in step behind the scenes.

## What to keep in mind

- **Eventual durability.** A write hits memory instantly and disk a moment later.
  A crash in that gap loses only the last unflushed commit; the `pagehide` /
  `beforeunload` flush shrinks the window, but it is best-effort. If you need
  hard durability per write, write to the persistent tier directly and accept the
  async latency.
- **One writer.** This assumes a single tab owns the IndexedDB database. Multiple
  tabs writing the same store need cross-tab coordination — see the
  [Sync Engine guide](/guides/sync-engine/).
- **Tag re-applied writes.** If you later replay persisted or remote changes back
  into the in-memory tier, tag those transactions with a
  [trait](/runtime/db/#traits) and skip them in the subscriber, so a write isn't
  persisted in a loop. The sync engine uses a `skip-sync` trait for exactly this.
- **Batch large hydrations.** For very large tables, chunk the insert in step 3
  (e.g. 1,000 rows per `insert`) to keep a single transaction bounded.

## Next steps

This setup gives you instant, persistent local storage. To make multiple clients
(and a server) converge on the same data, add change tracking and merge on top —
the [Sync Engine guide](/guides/sync-engine/) does precisely that, reusing the two
tiers you built here.
