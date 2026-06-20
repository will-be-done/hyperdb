---
title: Quickstart
description: Define a table, create a database, run selectors and actions, and wire it into React.
sidebar:
  order: 3
---

This quickstart builds a tiny task app end to end: a schema, a selector, an
action, a database, and a React component.

## 1. Install

```bash
npm install @will-be-done/hyperdb-lib
# React integration (optional)
npm install react react-dom
```

## 2. Define a table

A table needs a string `id`. HyperDB automatically adds a hash index named
`byId`; declare any additional indexes you want to query by.

```ts
// schema.ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb-lib";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
}).index("byProjectOrder", ["projectId", "orderToken"]);

export type Task = ExtractSchema<typeof tasksTable>;
```

## 3. Create shared builders

The library exports the factories `createSelector` and `createAction`. Create a
`selector` and an `action` once and reuse them across your app — this is where
you set defaults like argument validation.

```ts
// builders.ts
import { createSelector, createAction } from "@will-be-done/hyperdb-lib";

export const selector = createSelector({ validateArgs: false });
export const action = createAction({ validateArgs: false });
```

## 4. Write a selector and an action

```ts
// tasks.ts
import { selectFrom, insert, v } from "@will-be-done/hyperdb-lib";
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

For local, ephemeral data the in-memory driver is the simplest choice. Wrap the
core `DB` in a `SubscribableDB` so selectors can react to changes.

```ts
// db.ts
import { DB, SubscribableDB } from "@will-be-done/hyperdb-lib";
import { BptreeInmemDriver } from "@will-be-done/hyperdb-lib/drivers/inmemory";
import { tasksTable } from "./schema";

const baseDb = new DB(new BptreeInmemDriver());
export const db = new SubscribableDB(baseDb);

db.loadTables([tasksTable]);
```

## 6. Read and write outside React

```ts
import { syncDispatch, select } from "@will-be-done/hyperdb-lib";
import { db } from "./db";
import { createTask, projectTasks } from "./tasks";

syncDispatch(db, createTask({ id: "task-1", projectId: "p1", title: "Ship it" }));

const tasks = select(db, projectTasks({ projectId: "p1" }));
console.log(tasks); // [{ id: "task-1", ... }]
```

## 7. Use it in React

Provide the database through `DBProvider`, then read with `useSyncSelector` and
write with `useDispatch`.

```tsx
import { DBProvider, useSyncSelector, useDispatch } from "@will-be-done/hyperdb-lib/react";
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
            createTask({ id: crypto.randomUUID(), projectId, title: "New task" }),
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
    </DBProvider>
  );
}
```

The list re-renders automatically whenever a `createTask` (or any mutation
touching the queried range) commits.

## Where to next

- [Schemas](/database/schemas/) — tables, validators, tagged unions.
- [Reading Data](/database/reading-data/) and [Indexes](/database/indexes/) —
  the full query builder.
- [Writing Data](/database/writing-data/) — actions, mutations, transactions.
- [Storage Drivers](/runtime/drivers/) — persist to SQLite or IndexedDB.
