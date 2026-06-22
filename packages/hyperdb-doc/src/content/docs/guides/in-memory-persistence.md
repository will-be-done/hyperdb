---
title: In-Memory Store with Persistence
description: Run a synchronous in-memory HyperDB for the UI and mirror each change to a persistent IndexedDB tier.
sidebar:
  order: 1
  label: In-Memory + Persistence
---

One common local-first setup uses two tiers: the UI reads and writes a
synchronous in-memory database, and each change is mirrored to a persistent
database (IndexedDB) in the background. On startup you load the persisted rows
back into memory.

This keeps selectors and actions synchronous in the UI while still persisting
data between reloads. This guide builds that setup from scratch.

This is persistence, not multi-client sync. If you also need change tracking,
cross-tab sync, merge, and a server peer, the [Sync Engine
guide](/guides/sync-engine/) layers those concerns on top of the same two-tier
shape.

## The shape

```
        write (sync)                 mirror (async)
  UI ──────────────▶  in-memory DB ──────────────▶  IndexedDB
       read (sync)    (SubscribableDB)   subscribe   (persistent)
                            ▲                              │
                            └───────── hydrate ────────────┘
                                   (load on startup)
```

Three moving parts: hydrate on startup, subscribe to in-memory commits,
and persist each batch of changes to IndexedDB.

## 1. Give each persisted table a full-scan index

To hydrate you need to read _every_ row of a table. The built-in `byId` index is
a hash index, so it can only look up a single id, not scan a whole table. So add
a btree index over `id` (here `byIds`) to every table you persist:

```ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb";

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
table, and that's what hydration reads.

## 2. Create both databases

The in-memory tier is a [`SubscribableDB`](/runtime/db/) over the
[in-memory driver](/runtime/drivers/#in-memory) (synchronous). The persistent
tier is a plain [`DB`](/runtime/db/) over the
[IndexedDB driver](/runtime/drivers/#indexeddb) (asynchronous), so its
`loadTables` runs through `execAsync`.

```ts
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
import { DB, SubscribableDB, execAsync, execSync } from "@will-be-done/hyperdb";
import { tasksTable, projectsTable } from "./tables";

const persistedTables = [tasksTable, projectsTable];

export async function createStores(dbName: string) {
  // Persistent tier: IndexedDB, async
  const persistentDB = new DB(await openIndexedDBDriver(dbName));
  await execAsync(persistentDB.loadTables(persistedTables));

  // In-memory tier: synchronous; this is what the UI reads and writes
  const memDB = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(memDB.loadTables(persistedTables));

  return { persistentDB, memDB };
}
```

Both tiers load the same table definitions; the only difference is the
driver underneath.

## 3. Hydrate the in-memory tier

On startup, read every row from the persistent tier and insert it into memory.
Reads from IndexedDB are async (`selectAsync`); the insert into memory is sync
(`syncDispatch`). Wrap both sides in named actions/selectors so they show up in
the devtool trace — the scan is where you can see what reading a table back from
IndexedDB actually costs.

```ts
import {
  createAction,
  createSelector,
  insert,
  selectAsync,
  selectFrom,
  syncDispatch,
  v,
  type HyperDB,
  type SubscribableDB,
  type TableDefinition,
} from "@will-be-done/hyperdb";

// Name the persistence operations so they show up in the devtool trace
// alongside your app's own actions and selectors. Reuse the same builders your
// app already uses if you have them.
const action = createAction({ trace: { enabled: true, startOn: "load" } });
const selector = createSelector({ trace: { enabled: true, startOn: "load" } });

// Full-table scan over the `byIds` btree index — the read you can watch in the
// trace to see what hydrating a table from IndexedDB costs.
const scanTable = selector({
  name: "hydrate:scan",
  args: { table: v.pass<TableDefinition>() },
  handler: function* scanTable({ table }) {
    return yield* selectFrom(table, "byIds").order("asc");
  },
});

// Load the scanned rows into the in-memory tier (fires the afterChange hooks).
const loadRows = action({
  name: "hydrate:load",
  args: {
    table: v.pass<TableDefinition>(),
    rows: v.pass<Record<string, unknown>[]>(),
  },
  handler: function* loadRows({ table, rows }) {
    if (rows.length > 0) yield* insert(table, rows);
  },
});

async function hydrate(
  persistentDB: HyperDB,
  memDB: SubscribableDB,
  tables: TableDefinition[],
) {
  for (const table of tables) {
    const rows = await selectAsync(persistentDB, scanTable({ table }));
    syncDispatch(memDB, loadRows({ table, rows }));
  }
}
```

After `hydrate` returns, the in-memory tier holds a complete copy of your data and
the UI can read it synchronously.

:::caution
Hydration loads the whole dataset into memory. That can work well for a
local-first client (one user's data), but it's the opposite of the
[server pattern](/start/why/#the-backend-problem), where the runtime pulls in only
the rows a selector touches. Don't hydrate an unbounded server table this way.
:::

:::note[Load on demand: a hybrid mode (in development)]
Eager hydration is the simplest model, but not the only one. A hybrid mode,
currently in development, flips it around: instead of loading everything up front, a read
checks the in-memory tier first and, on a miss, runs the _same_ query against the
persistent tier and caches the result back into memory for next time.

The trade-off is that selectors and dispatch become async (a read may need to
fall through to disk), but startup stays quick and memory stays low, because
data is pulled in lazily, on demand. Writes still commit synchronously for any
rows already cached, so if you preload the working set, actions stay synchronous
while other rows load on first access. This guide uses the eager model;
reach for hybrid mode when the dataset is too large to hold fully in memory or
when startup time matters more than synchronous reads.
:::

## 4. Mirror every change to disk

Subscribe to the in-memory `SubscribableDB`. Each committed transaction hands you
the list of [`Op`s](/database/selectors-reactivity/#subscriptions-and-revisions)
(`insert` / `upsert` / `delete`, each carrying the affected rows). Queue them and
apply them to the persistent tier.

Because IndexedDB is async while commits arrive synchronously, a small queue
serializes the writes so batches are persisted in commit order, one
transaction at a time.

A single commit arrives as one `Op` per row — a bulk insert of 10,000 rows is
10,000 `insert` ops. Don't apply them one at a time: `insert` / `upsert` /
`deleteRows` each accept an _array_, and the driver issues all of a call's
IndexedDB requests as one pipelined burst inside the transaction. Awaiting each
op separately throws that away — it serializes 10,000 round-trips instead of
pipelining them. So coalesce consecutive ops of the same type and table into a
single call, inside a named `persist:batch` action you can watch in the trace:

```ts
import {
  asyncDispatch,
  deleteRows,
  insert,
  upsert,
  v,
  type HyperDB,
  type Op,
  type InsertOp,
  type UpsertOp,
  type DeleteOp,
  type SubscribableDB,
} from "@will-be-done/hyperdb";

// Split ops into runs of the same type + table, keeping their original order.
// A bulk insert collapses into one run the driver can pipeline; an interleaved
// insert/delete of the same row stays in two ordered runs.
function groupConsecutiveOps(ops: Op[]): Op[][] {
  const runs: Op[][] = [];
  for (const op of ops) {
    const last = runs.at(-1);
    if (last && last[0].type === op.type && last[0].table === op.table) {
      last.push(op);
    } else {
      runs.push([op]);
    }
  }
  return runs;
}

// Apply one commit's worth of ops to the persistent tier. Coalesced into one
// call per run, so a bulk insert is a single `insert` span the driver can
// pipeline — the write you can watch in the trace to see how fast it lands.
// (reuses the `action` builder from step 3)
const persistOps = action({
  name: "persist:batch",
  args: { ops: v.pass<Op[]>() },
  handler: function* persistOps({ ops }) {
    for (const run of groupConsecutiveOps(ops)) {
      const { type, table } = run[0];
      if (type === "insert") {
        yield* insert(
          table,
          run.map((op) => (op as InsertOp).newValue),
        );
      } else if (type === "upsert") {
        yield* upsert(
          table,
          run.map((op) => (op as UpsertOp).newValue),
        );
      } else {
        yield* deleteRows(
          table,
          run.map((op) => (op as DeleteOp).oldValue.id),
        );
      }
    }
  },
});

export function startPersisting(persistentDB: HyperDB, memDB: SubscribableDB) {
  const pending: Op[][] = [];
  let draining = false;

  async function persistBatch(ops: Op[]) {
    // asyncDispatch opens a tx, runs the (traced) persist:batch action, and
    // commits — or rolls back on failure. The op coalescing lives in the action.
    await asyncDispatch(persistentDB, persistOps({ ops }));
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

  // If a batch is still in flight or queued, kick off a flush and warn the
  // user before the tab closes — that last commit hasn't reached disk yet.
  const beforeUnload = (event: BeforeUnloadEvent) => {
    flush(); // can't be awaited here; fire it off best-effort
    if (draining || pending.length > 0) {
      event.preventDefault();
      // Modern browsers ignore the text but need a value to show the prompt.
      event.returnValue = "Saving to IndexedDB is still in progress.";
      return event.returnValue;
    }
  };
  window.addEventListener("beforeunload", beforeUnload, { capture: true });

  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush, { capture: true });
    window.removeEventListener("beforeunload", beforeUnload, { capture: true });
  };
}
```

`asyncDispatch` opens the transaction, runs the `persist:batch` action, and
commits — or rolls back on any failure — so the whole batch lands atomically.
Coalescing only merges _consecutive_ same-type, same-table ops, so it preserves
order when a batch interleaves (e.g. an insert and a later delete of the same
id). Because both reads and writes go through named actions/selectors, the
`hydrate:scan`, `hydrate:load`, and `persist:batch` operations each show up as
spans in the devtool trace.

## 5. Wire it together

```ts
import { createStores } from "./stores";

export async function initStore(dbName: string) {
  const { persistentDB, memDB } = await createStores(dbName);

  await hydrate(persistentDB, memDB, persistedTables);
  startPersisting(persistentDB, memDB);

  // Hand the in-memory tier to the app; pass it to <DBProvider value={memDB}>
  return memDB;
}
```

From here, the app only ever talks to `memDB`: reads via
[`useSyncSelector`](/integrations/react/), writes via
[`useDispatch`](/integrations/react/). Both run synchronously; the
persistence loop keeps disk in step behind the scenes.

## What to keep in mind

- Eventual durability. A write hits memory first and disk a moment later.
  A crash in that gap loses only the last unflushed commit; the `pagehide` /
  `beforeunload` flush shrinks the window, and the `beforeunload` prompt warns
  before a close while a batch is still queued. (Browsers ignore the prompt's
  custom text and only show it after the user has interacted with the page.) If
  you need hard durability per write, write to the persistent tier directly and
  accept the async latency.
- One writer. This assumes a single tab owns the IndexedDB database. Multiple
  tabs writing the same store need cross-tab coordination; see the
  [Sync Engine guide](/guides/sync-engine/).
- Tag re-applied writes. If you later replay persisted or remote changes back
  into the in-memory tier, tag those transactions with a
  [trait](/runtime/db/#traits) and skip them in the subscriber, so a write isn't
  persisted in a loop. The sync engine uses a `skip-sync` trait for this.
- Batch large hydrations. For very large tables, chunk the insert in step 3
  (e.g. 1,000 rows per `insert`) to keep a single transaction bounded.

## Next steps

This setup gives you synchronous UI reads/writes with persistent local storage. To make multiple clients
(and a server) converge on the same data, add change tracking and merge on top.
The [Sync Engine guide](/guides/sync-engine/) describes that next layer, reusing
the two tiers you built here.
