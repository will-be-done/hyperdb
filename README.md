# HyperDB

**The reactive, local-first database for TypeScript.** Write your schema,
queries, selectors, and actions once, then run the exact same code in the
browser _and_ on the server.

📖 **[Full documentation → hyperdb.will-be-done.app](https://hyperdb.will-be-done.app)**

## What it solves

HyperDB brings the developer experience of a backend like
[Convex](https://www.convex.dev/) to a database that runs **everywhere your
TypeScript runs**. You describe data with typed schemas, read it through reactive
selectors, and change it through transactional actions: no SQL, and no thinking
about the storage engine underneath. The same slice of schema + selectors +
actions runs unchanged on the client and the backend; only the storage driver
differs.

It was built to fix the things that hurt when you reach for Redux or MobX or other state management libs in a local-first app:

- **Cheap inserts into sorted data.** Every table index is backed by a real B-tree, so
  inserting into a sorted collection stays `O(log n)` instead of the `O(n)` you
  pay rebuilding (Redux) or shifting (MobX) an array. Ideal for fractional
  indexing for local-first apps.
- **Fine-grained reactivity.** Selectors record exactly which index ranges they
  scanned, so a mutation only re-runs the selectors that overlap it, without
  proxies or `observer()`.
- **Run the same logic on the backend.** Because a table index is just a B-tree, the
  same schema, selectors, and actions run against a persistent store on the
  server (SQLite today, pg/mongodb in future). The runtime reads only the rows a selector touches; it
  never loads the whole dataset into memory.
- **Instant on the frontend.** Against the in-memory driver, selectors and
  actions execute **synchronously** (no `await`, no microtask hop), so a click
  updates the store and the UI in the same tick.
- **Just JavaScript, no SQL.** Selectors and actions are ordinary JS: loops,
  conditionals, function calls. You get fast indexed lookups underneath, not a
  query language to learn.

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
  backend, or hand-roll in-memory indexes and manual invalidation.

## Installation

```bash
npm install @will-be-done/hyperdb
```

The React devtool ships separately. It traces every selector run and mutation
into a browsable call tree, so you can see which index a slow view scanned:

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
}).index("byProjectOrder", ["projectId", "orderToken"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

```ts
// 2. Create shared builders
import { createSelector, createAction } from "@will-be-done/hyperdb";

export const selector = createSelector({ validateArgs: false });
export const action = createAction({ validateArgs: false });
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

```ts
// 4. Create a database (in-memory + reactive)
import { DB, SubscribableDB } from "@will-be-done/hyperdb";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { tasksTable } from "./schema";

export const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
db.loadTables([tasksTable]);
```

```tsx
import {
  DBProvider,
  useSyncSelector,
  useDispatch,
} from "@will-be-done/hyperdb/react";
import { HyperDBDevtools } from "@will-be-done/hyperdb-devtool/react";
import { db } from "./db";
import { createTask, projectTasks } from "./tasks";

function Tasks({ projectId }: { projectId: string }) {
  const tasks = useSyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });
  const dispatch = useDispatch();

  return (
    <>
      <button
        onClick={() =>
          dispatch(
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

export function App() {
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
| `@will-be-done/hyperdb`                  | Core: `defineTable`, `v`, `selectFrom`, builders, `DB`, `SubscribableDB` |
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
- [Storage Drivers](https://hyperdb.will-be-done.app/runtime/drivers/): in-memory, IndexedDB, SQLite
- [Devtools & Tracing](https://hyperdb.will-be-done.app/integrations/devtools/): inspect selector runs and mutations
- [Building a Sync Engine](https://hyperdb.will-be-done.app/guides/sync-engine/): share change-tracking code across client and server

> On the server the persistent store is SQLite today (MongoDB and PostgreSQL are
> not supported yet). HyperDB gives you the storage, query, and reactivity
> primitives, and you build synchronization on top with the built-in primitives.
