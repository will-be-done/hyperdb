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

It is designed for the parts of local-first apps where plain client state starts
to strain:

- **Efficient inserts into sorted data.** Every table index is backed by a real
  B-tree, so inserting into a sorted collection stays `O(log n)` instead of
  rebuilding or shifting a whole array. This fits fractional indexing in
  local-first apps.
- **Compact persistent indexes.** SQLite and IndexedDB use binary ordered keys,
  direct primary-key access for `byId`, and one physical index for compatible
  `uniqhash`/B-tree declarations. Non-unique ordering remains deterministic
  because `id` is the final tie-breaker.
- **Explicit query execution.** SQL is powerful, but the query text does not
  usually tell you whether the database will use an index or scan a whole table.
  In HyperDB, selectors name the table index they read and build explicit bounds
  over it, so the code shows the access path it will take.
- **Fine-grained reactivity.** Selectors record exactly which index ranges they
  scanned, so a mutation only re-runs the selectors that overlap it, without
  proxies or `observer()`.
- **Lazy persistent reads when you need them.** `HybridDB` combines a persistent
  primary store with an in-memory B-tree cache. Reads return cached ranges when
  possible and load missing ranges from the primary store on demand. Writes
  update the cache first so the UI can respond immediately, then flush to the
  primary store in order.
- **Run the same logic on the backend.** Because a table index is just a B-tree, the
  same schema, selectors, and actions run against a persistent store on the
  server (SQLite today, pg/mongodb in future). The runtime reads only the rows a
  selector touches instead of hydrating the whole dataset into memory.
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
  indexing, where array-based state becomes costly.
- Anywhere you'd otherwise duplicate models and queries between frontend and
  backend.

## Installation

```bash
npm install @will-be-done/hyperdb
```

The React devtool ships separately. It traces every selector run and mutation
into a browsable call tree, so you can see which index a slow view scanned. For
HybridDB reads, select nodes are labeled `in-mem` or `persist` to show whether
the returned rows came from the memory cache or the primary persistent store,
and trace rows get an `in-mem` badge when no select fell through to a persistent
scan — every read was served from the memory cache (mutations, which flush
separately, don't affect it). You can sort traces by creation time, duration, or
rows fetched, and when you switch traces, the active detail tab stays selected so
comparison stays focused:

```bash
npm install @will-be-done/hyperdb-devtool
```

## Quick start

```ts
// 1. Define a typed table (id + query indexes)
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  slug: v.string(),
  orderToken: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  .index("bySlug", ["slug"], { type: "uniqhash" })
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
    yield* insert(tasksTable, [
      { id, projectId, title, slug: id, orderToken: id },
    ]);
  },
});
```

Queries can also return OR branches with `or(...)` or arrays from `where`.
When combined with `.order(...)`, those branches are merged into the index order
before rows are returned.

```ts
// 4. Create a HybridDB (IndexedDB primary + in-memory cache)
import { DB, HybridDB, SubscribableDB, execAsync } from "@will-be-done/hyperdb";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { tasksTable } from "./schema";

export async function createAppDB() {
  const primary = new DB(await openIndexedDBDriver("task-app"), {
    runtimeRowsValidation: process.env.NODE_ENV === "development",
    freezeArgs: process.env.NODE_ENV === "development",
    freezeRows: process.env.NODE_ENV === "development",
  });
  const cache = new DB(new BptreeInmemDriver());
  const db = new SubscribableDB(new HybridDB(primary, cache));

  await execAsync(db.loadTables([tasksTable]));

  // Optional: warm the cache with the whole table so future reads can stay in memory.
  // await execAsync(
  //   db.preloadTables([{ table: tasksTable, scanIndex: "byIds" }]),
  // );

  return db;
}
```

If your whole app state can be loaded into memory at startup, you may not need
`HybridDB`. A plain `new SubscribableDB(new DB(new BptreeInmemDriver()))` keeps
reads and writes synchronous, so you can use `useSyncSelector`, `useSyncDispatch`,
`selectSync`, and `syncDispatch` without promise or cache-miss tradeoffs.
For one-off reads that should reuse the selector cache, use `selectCachedSync`,
`selectCachedAsync`, or `selectCachedMaybeAsync`. For subscriptions outside
React, use `createSelectorStoreSync` / `createCachedSelectorStoreSync` when
selector results are available synchronously. Use `createAsyncSelectorStore` /
`createCachedSelectorStoreAsync` when a `HybridDB`/async driver run may need to
resolve a promise and expose query state.

`SubscribableDB` also exposes lifecycle hooks: mutation hooks such as
`afterInsert`, `afterUpsert`, `afterDelete`, and `afterChange`, plus `afterScan`
for successful index scans. `HybridDB` keeps the primary store persistent while
serving cached index ranges from memory and loading missing range portions from
the primary store.

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

`useAsyncSelector` attempts the selector once for its initial snapshot. If the
run finishes synchronously, that value is visible immediately; if it returns a
promise, the hook shows `defaultValue`, `initialData`, or `placeholderData` until
that same promise resolves. The hook uses `createCachedSelectorStoreAsync`
internally, so the same async subscription behavior is available without React.
`defaultValue` may be a value or a zero-argument function that returns the value.

## Entry points

| Import path                              | Contents                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `@will-be-done/hyperdb`                  | Core: `defineTable`, `v`, `selectFrom`, builders, `DB`, `HybridDB`, `SubscribableDB` |
| `@will-be-done/hyperdb/react`            | React hooks and `DBProvider`                                                         |
| `@will-be-done/hyperdb/tracing`          | Tracing store and tracer configuration                                               |
| `@will-be-done/hyperdb/drivers/inmemory` | `BptreeInmemDriver`                                                                  |
| `@will-be-done/hyperdb/drivers/sqlite`   | `SqlDriver`, `AsyncSqlDriver`                                                        |
| `@will-be-done/hyperdb/drivers/idb`      | `openIndexedDBDriver`, `IdbDriver`                                                   |
| `@will-be-done/hyperdb-devtool/react`    | `HyperDBDevtools`, `HyperDBDevtoolsPanel` (separate package)                         |

## Learn more

- [Introduction](https://hyperdb.will-be-done.app/start/introduction/): what HyperDB is and when to use it
- [Why HyperDB?](https://hyperdb.will-be-done.app/start/why/): the data-modeling and reactivity problems it is built to solve
- [How HyperDB Works](https://hyperdb.will-be-done.app/start/how-it-works/): the mental model
- [Quickstart](https://hyperdb.will-be-done.app/start/quickstart/): define a table, run a query, wire it into React
- [LLM Cheat Sheet](https://hyperdb.will-be-done.app/start/llm-cheat-sheet/): compact context to paste into another project
- [Storage Drivers](https://hyperdb.will-be-done.app/runtime/drivers/): in-memory, IndexedDB, SQLite
- [Devtools & Tracing](https://hyperdb.will-be-done.app/integrations/devtools/): inspect selector runs and mutations
- [Building a Sync Engine](https://hyperdb.will-be-done.app/guides/sync-engine/): share change-tracking code across client and server

> On the server the persistent store is SQLite today (MongoDB and PostgreSQL are
> not supported yet). HyperDB gives you the storage, query, and reactivity
> primitives, and you build synchronization on top with the built-in primitives.

The SQLite drivers support large batches of OR selector clauses up to SQLite's
bind-parameter limit without requiring application-level workarounds for
SQLite's expression-depth limit.

Table definitions reject duplicate index shapes and overlapping B-tree column
prefixes. Persistent drivers automatically migrate older textual sort keys to
the binary ordered-key representation when tables are loaded.
