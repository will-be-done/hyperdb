---
title: Quickstart
description: Define a table, create a database, run selectors and actions, and wire it into React.
sidebar:
  order: 4
---

This quickstart builds a tiny task app end to end: a schema, a selector, an
action, a database, and a React component.

## 1. Install

```bash
npm install @will-be-done/hyperdb
# React integration (optional)
npm install react react-dom
# Devtool (optional)
npm install @will-be-done/hyperdb-devtool
```

## 2. Define a table

A table needs a string `id`. HyperDB automatically adds a unique hash index
named `byId`; declare any additional indexes you want to query by.
The `byIds` index below is a B-tree full-table scan index used by the optional
HybridDB preload step.

```ts
// schema.ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  .index("byIds", ["id"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

## 3. Create shared builders

The library exports the factories `createSelector` and `createAction`. Create a
`selector` and an `action` once and reuse them across your app. This is where
you set defaults like argument validation.

```ts
// builders.ts
import { createSelector, createAction } from "@will-be-done/hyperdb";

export const selector = createSelector({
  validateArgs: process.env.NODE_ENV === "development",
});
export const action = createAction({
  validateArgs: process.env.NODE_ENV === "development",
});
```

## 4. Write a selector and an action

```ts
// tasks.ts
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
      { id, projectId, title, state: "todo", orderToken: id },
    ]);
  },
});
```

## 5. Create a database

For a browser app, create a `HybridDB` with IndexedDB as the primary store and
an in-memory B-tree cache for hot index ranges. Wrap it in a `SubscribableDB` so
selectors can react to changes.

```ts
// db.ts
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
reads and writes synchronous, so you can use `useSyncSelector`,
`useSyncDispatch`, `selectSync`, and `syncDispatch` without promise or cache-miss
tradeoffs.

## 6. Read and write outside React

```ts
import { asyncDispatch, selectAsync } from "@will-be-done/hyperdb";
import { createAppDB } from "./db";
import { createTask, projectTasks } from "./tasks";

const db = await createAppDB();

await asyncDispatch(
  db,
  createTask({ id: "task-1", projectId: "p1", title: "Ship it" }),
);

const tasks = await selectAsync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
console.log(tasks); // [{ id: "task-1", ... }]
```

## 7. Use it in React

Provide the database through `DBProvider`, then read with `useAsyncSelector` and
write with `useAsyncDispatch`.

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
      <HyperDBDevtools db={db} initialIsOpen={false} />
    </DBProvider>
  );
}
```

The list re-renders automatically whenever a `createTask` (or any mutation
touching the queried range) commits.

`useAsyncSelector` returns `data`, `status`, `error`, fetching flags, and
`refetch()`. Cached results stay visible while HybridDB loads missing ranges
from the primary store.

## Where to next

- [Schemas](/database/schemas/): tables, validators, tagged unions.
- [Selectors](/database/selectors/) and [Indexes](/database/indexes/):
  the full query builder.
- [Actions](/database/actions/): actions, mutations, transactions.
- [Storage Drivers](/runtime/drivers/): persist to SQLite or IndexedDB.
