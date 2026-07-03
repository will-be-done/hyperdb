---
title: Writing Data
description: Change data with actions and the insert, upsert, and deleteRows mutations, dispatched in transactions.
sidebar:
  order: 5
---

You change data through actions, generator functions that may both read and
write. Writes are expressed as the mutation commands `insert`, `upsert`, and
`deleteRows`. An action is executed by dispatching it, which runs the whole
action inside a single transaction. Actions compose like ordinary code: they can
call selectors, issue writes, call other actions, then read again.

## Defining an action

```ts
import { insert, v } from "@will-be-done/hyperdb";
import { action } from "./builders"; // createAction()
import { tasksTable } from "./schema";

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

Object-form actions accept `name`, `args`, `handler`, and `skipTrace`. As with
selectors, you can also wrap a bare generator function.

Actions may read with `selectFrom` or by calling selectors before they write.
Read-modify-write within the same transaction is the common pattern.

## Composing actions

Use `yield*` to compose selectors and actions. Nested actions run inside the
same transaction as their parent action, so the whole workflow commits or rolls
back together.

```ts
import { selectFrom, upsert, v } from "@will-be-done/hyperdb";
import { selector, action } from "./builders";
import { tasksTable } from "./schema";

export const taskById = selector({
  name: "taskById",
  args: { id: v.string() },
  handler: function* ({ id }) {
    return yield* selectFrom(tasksTable, "byId")
      .where((q) => q.eq("id", id))
      .first();
  },
});

export const markTaskDone = action({
  name: "markTaskDone",
  args: { id: v.string() },
  handler: function* ({ id }) {
    const task = yield* taskById({ id }); // selector in action
    if (!task) return;

    yield* upsert(tasksTable, [{ ...task, state: "done" }]);
  },
});

export const completeAndMoveTask = action({
  name: "completeAndMoveTask",
  args: { id: v.string(), toProject: v.string(), orderToken: v.string() },
  handler: function* ({ id, toProject, orderToken }) {
    yield* markTaskDone({ id }); // action in action

    const task = yield* taskById({ id });
    if (!task) return;

    yield* upsert(tasksTable, [{ ...task, projectId: toProject, orderToken }]);
  },
});
```

## The mutations

### `insert`

Adds new rows. Fails if any `id` already exists.

```ts
yield *
  insert(tasksTable, [
    { id: "t1", projectId: "p1", title: "A", state: "todo", orderToken: "a" },
    { id: "t2", projectId: "p1", title: "B", state: "todo", orderToken: "b" },
  ]);
```

### `upsert`

Inserts or replaces the whole row by `id`. There is no partial update, so pass
the complete row. To change one field, read the current row first and spread it:

```ts
const current =
  yield *
  selectFrom(tasksTable, "byId")
    .where((q) => q.eq("id", id))
    .first();

if (current) {
  yield * upsert(tasksTable, [{ ...current, state: "done" }]);
}
```

If the same `id` appears more than once in a single `upsert` batch, the last
occurrence wins.

### `deleteRows`

Deletes rows by `id`. Ids that don't exist are ignored, so deleting is
idempotent.

```ts
yield * deleteRows(tasksTable, ["t1", "t2"]);
```

## Dispatching actions

Dispatching runs an action in a transaction: if the handler throws, the
transaction rolls back and nothing is written. Use the variant that matches your
runtime.

```ts
import { syncDispatch, asyncDispatch } from "@will-be-done/hyperdb";

// synchronous drivers (in-memory, sync SQLite)
syncDispatch(db, createTask({ id: "t1", projectId: "p1", title: "Ship" }));

// asynchronous runtimes (IndexedDB, async SQLite, HybridDB)
await asyncDispatch(
  db,
  createTask({ id: "t1", projectId: "p1", title: "Ship" }),
);
```

Inside React use [`useDispatch` / `useAsyncDispatch`](/integrations/react/), which
bind the dispatcher to the database from context.

With `HybridDB`, use the async dispatch path. Writes update the in-memory cache
first so subscribers and React can respond immediately, then flush to the
primary store in order. See [`HybridDB`](/runtime/db/#hybriddb) for the
persistence and crash-handling details.

## Selectors can't write

The command runner only permits mutations while dispatching an action. If a
selector emits `insert`, `upsert`, or `deleteRows`, the runtime throws
(`Writes are disallowed for command: insert`). This keeps reads pure and is what
makes selector caching safe.

## Transactions

Every dispatch is atomic. A single action can perform many reads and writes
across multiple tables, including reads through selectors and writes from nested
actions; they all commit together or not at all.

```ts
export const moveTask = action({
  name: "moveTask",
  args: { id: v.string(), toProject: v.string(), orderToken: v.string() },
  handler: function* ({ id, toProject, orderToken }) {
    const task = yield* selectFrom(tasksTable, "byId")
      .where((q) => q.eq("id", id))
      .first();
    if (!task) throw new Error("not found"); // rolls back, writes nothing

    yield* upsert(tasksTable, [{ ...task, projectId: toProject, orderToken }]);
  },
});
```

When you dispatch against a [`SubscribableDB`](/runtime/db/), the commit bumps a
revision and notifies subscribers with the exact rows that changed. This is what
drives reactive selectors and the `afterInsert` / `afterUpsert` / `afterDelete` /
`afterChange` mutation hooks. `SubscribableDB` also exposes `afterScan` for
successful reads.

## Bulk writes

`insert`, `upsert`, and `deleteRows` all take arrays, so batch your writes
into a single command rather than looping.
