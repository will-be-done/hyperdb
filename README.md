# HyperDB

**The reactive database for local-first apps.** Define schemas, queries,
selectors, and actions once, then use that data layer in the browser and on the
server.

<img width="2920" height="1736" alt="image" src="https://github.com/user-attachments/assets/023a5f91-bdea-4208-b2fc-1f445c958916" />

[![Open demo in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/edit/github-knqvrapn?file=packages%2Fhyperdb-demo%2Fsrc%2Fdb.ts)

📖 **[Full documentation → hyperdb.will-be-done.app](https://hyperdb.will-be-done.app)**

## What it solves

HyperDB brings the developer experience of a backend like Convex to a database
that can run in the browser and on the server. You describe data with typed
schemas, read it through reactive selectors, and change it through
transactional actions. The same slice of schema, selectors, and actions can be
shared by the client and backend; only the storage driver differs.

It is designed for the parts of local-first apps where Redux, MobX, or plain
state libraries start to strain:

- **Efficient inserts into sorted data.** Every table index is backed by a real B-tree, so
  inserting into a sorted collection stays `O(log n)` instead of the `O(n)` you
  pay rebuilding (Redux) or shifting (MobX) an array. This fits fractional
  indexing in local-first apps.
- **Fine-grained reactivity.** Selectors record exactly which index ranges they
  scanned, so a mutation only re-runs the selectors that overlap it, without
  proxies or `observer()`.
- **Run the same logic on the backend.** Because a table index is just a B-tree, the
  same schema, selectors, and actions run against a persistent store on the
  server (SQLite today, pg/mongodb in future). The runtime reads only the rows a
  selector touches instead of hydrating the whole dataset into memory.
- **Lazy persistent reads when you need them.** `HybridDB` pairs a persistent
  primary store with an in-memory cache: reads check memory first, fall through
  to persistent storage on a miss, then cache the covered index range for next
  time. Cache fills, write-through mutations, and transactions are serialized
  per HybridDB instance so async selectors and actions do not overlap against
  the in-memory cache tier. The committed cache snapshot remains synchronously
  readable while a write transaction is active, so React can keep showing cached
  data without seeing uncommitted writes. Drivers explicitly report whether
  selector readonly transactions are supported; enabled drivers use
  `beginTx("readonly")` for scoped reuse. With an IndexedDB primary, that
  readonly transaction starts only when the persistent tier is actually read,
  and is reopened once if the browser finishes it between scans. IDB operation
  logs include transaction ids and selector/action names when a run context is
  available. When a workflow should start warm, call `db.preloadTables(...)`
  with a B-tree full-scan index such as `byIds` to load whole tables into the
  cache and mark their indexes as resident when the DB is a HybridDB wrapper, or
  call `preloadSelector(...)` with the same selector args a route will render to
  warm the selector result too. Retained selector cache entries keep tracking DB
  changes until GC: unrelated mutations advance the cached revision without a
  re-run, while mutations inside the selector's read ranges mark unused entries
  stale so they re-run lazily on the next preload or read.
- **Hybrid-first React reads.** `HybridDB` is the recommended frontend shape for
  durable local state: IndexedDB or async SQLite as the primary store, an
  in-memory B-tree cache for hot ranges, and React reading through
  `useAsyncSelector`. Cached results stay visible while missing ranges load in
  the background, and writes go through `useAsyncDispatch` / `asyncDispatch` so
  both tiers commit together. `preloadSelector(...)` uses the same cache bridge
  outside React, so route loaders can warm HybridDB and the in-memory selector
  snapshot in one call. The async React API returns a React Query-style object
  with `data`, `status`, `error`, fetching flags, and `refetch()`.
- **JavaScript selectors and actions.** Selectors and actions are ordinary JS: loops,
  conditionals, function calls. You get fast indexed lookups underneath, not a
  query language to learn.

The devtool records selector runs and mutations in a call tree:

<img width="1999" height="745" alt="image" src="https://github.com/user-attachments/assets/428d892b-8982-4bd5-8b62-402c04218690" />

## Who needs this

Reach for HyperDB when you want **structured, queryable, reactive data** shared
across your whole stack:

- **Local-first apps** that work offline and sync to a server in the background,
  plus a server that runs the very same schema and sync logic.
- Apps with rich data models (tasks, documents, boards) that need indexed lookups
  and ordering on both client and server.
- **Large sorted collections** you reorder or insert into with fractional
  indexing, where a plain Redux/MobX array degrades to `O(n)`.
- Anywhere you'd otherwise duplicate models and queries between frontend and
  backend.

## Installation

```bash
npm install @will-be-done/hyperdb
```

The React devtool ships separately. It traces every selector run and mutation
into a browsable call tree, so you can see which index a slow view scanned. For
HybridDB reads, select nodes are labeled `in-mem` or `persist` to show whether
the returned rows came from the memory cache or the primary persistent store.
You can sort traces by creation time, duration, or rows fetched, and when you
switch traces, the active detail tab stays selected so comparison stays focused:

```bash
npm install @will-be-done/hyperdb-devtool
```

## Quick start

```ts
// 1. Define a typed table (id + a queryable index)
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  orderToken: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  // B-tree full-table scan index used by HybridDB preloading.
  .index("byIds", ["id"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

```ts
// 2. Create shared builders
import { createSelector, createAction } from "@will-be-done/hyperdb";

export const selector = createSelector({
  validateArgs: process.env.NODE_ENV === "development",
});
export const action = createAction({
  validateArgs: process.env.NODE_ENV === "development",
});
```

```ts
// 3. Write a selector and an action as plain generators
import { selectFrom, insert, v } from "@will-be-done/hyperdb";
import { selector, action } from "./builders";
import { tasksTable } from "./schema";

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
    yield* insert(tasksTable, [{ id, projectId, title, orderToken: id }]);
  },
});
```

Queries can also return OR branches with `or(...)` or arrays from `where`.
When combined with `.order(...)`, those branches are merged into the index order
before rows are returned.

```ts
// 4. Create a HybridDB (persistent primary + in-memory cache)
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

`SubscribableDB` also exposes lifecycle hooks: mutation hooks such as
`afterInsert`, `afterUpsert`, `afterDelete`, and `afterChange`, plus `afterScan`
for successful index scans. `HybridDB` keeps the persistent store durable while
serving cached index ranges from memory.

```tsx
import {
  DBProvider,
  useAsyncSelector,
  useAsyncDispatch,
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
    <>
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
        Add task
      </button>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>{task.title}</li>
        ))}
      </ul>
    </>
  );
}

export function App({ db }: { db: SubscribableDB }) {
  return (
    <DBProvider value={db}>
      <Tasks projectId="p1" />
      {/* Drop in the devtool to trace selectors and mutations */}
      <HyperDBDevtools db={db} initialIsOpen={false} />
    </DBProvider>
  );
}
```

## Entry points

| Import path                              | Contents                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `@will-be-done/hyperdb`                  | Core: `defineTable`, `v`, `selectFrom`, builders, `DB`, `HybridDB`, `SubscribableDB` |
| `@will-be-done/hyperdb/react`            | React hooks and `DBProvider`                                             |
| `@will-be-done/hyperdb/tracing`          | Tracing store and tracer configuration                                   |
| `@will-be-done/hyperdb/drivers/inmemory` | `BptreeInmemDriver`                                                      |
| `@will-be-done/hyperdb/drivers/sqlite`   | `SqlDriver`, `AsyncSqlDriver`                                            |
| `@will-be-done/hyperdb/drivers/idb`      | `openIndexedDBDriver`, `IdbDriver`                                       |
| `@will-be-done/hyperdb-devtool/react`    | `HyperDBDevtools`, `HyperDBDevtoolsPanel` (separate package)             |

## Learn more

- [Introduction](https://hyperdb.will-be-done.app/start/introduction/): what HyperDB is and when to use it
- [Why HyperDB?](https://hyperdb.will-be-done.app/start/why/): the problems with Redux/MobX that motivated it
- [How HyperDB Works](https://hyperdb.will-be-done.app/start/how-it-works/): the mental model
- [Quickstart](https://hyperdb.will-be-done.app/start/quickstart/): define a table, run a query, wire it into React
- [LLM Cheat Sheet](https://hyperdb.will-be-done.app/start/llm-cheat-sheet/): compact context to paste into another project
- [Storage Drivers](https://hyperdb.will-be-done.app/runtime/drivers/): in-memory, IndexedDB, SQLite
- [Devtools & Tracing](https://hyperdb.will-be-done.app/integrations/devtools/): inspect selector runs and mutations
- [Building a Sync Engine](https://hyperdb.will-be-done.app/guides/sync-engine/): share change-tracking code across client and server

> On the server the persistent store is SQLite today (MongoDB and PostgreSQL are
> not supported yet). HyperDB gives you the storage, query, and reactivity
> primitives, and you build synchronization on top with the built-in primitives.
