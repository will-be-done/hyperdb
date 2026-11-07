---
title: Actions
description: Change data with actions and the insert, upsert, and deleteRows mutations, dispatched in transactions.
sidebar:
  order: 6
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

Inside React use [`useSyncDispatch` / `useAsyncDispatch`](/integrations/react/),
which bind the dispatcher to the database from context.

`asyncDispatch` returns a promise, but runs cached operations and notifies
subscribers before returning. Execution suspends only for database I/O or a
busy transaction lock. Handlers cannot await other promises: fetch data or
generate ids outside the action and pass them in as args.

`dispatchMaybeAsync` runs the same transaction but returns the result directly
when nothing had to wait, and a promise only when a step suspended. Use it when
an integration wants to keep a synchronous fast path, for example a `HybridDB`
write served entirely by the in-memory cache:

```ts
import { dispatchMaybeAsync } from "@will-be-done/hyperdb";

const result = dispatchMaybeAsync(db, createTask(args));
const value = result instanceof Promise ? await result : result;
```

With `HybridDB` or `PreloadedHybridDB`, transactions publish memory changes
before the primary store saves them. To wait for all transactions committed
so far to reach storage, await `execAsync(db.waitForPersistence())` on the
runtime or its `SubscribableDB` wrapper. A rejected persistence wait reports
`HybridDBCrashedError`. See [runtime persistence](/runtime/db/#write-path)
for retry and recovery behavior.

## Selectors can't write

Selector handlers are typed to yield only read commands, so calling `insert`,
`upsert`, `deleteRows`, or an action inside a selector is a TypeScript error.
The runtime enforces the same rule for untyped code: a selector cannot write,
even when an action runs it, and a write from a selector throws a `HyperDBError`
with code `WRITES_DISALLOWED`. This keeps reads pure and is what makes selector
caching safe.

## Typing reusable helpers

Plain generator helpers compose with `yield*` like selectors and actions do.
Inferred return types work as is. When you annotate a helper, use
`SelectorGenerator<T>` for reads (usable in selectors and actions) or
`ActionGenerator<T>` for helpers that may write (usable only in actions):

```ts
import {
  selectFrom,
  upsert,
  type ActionGenerator,
  type SelectorGenerator,
} from "@will-be-done/hyperdb";
import { tasksTable, type Task } from "./schema";

function* findTask(id: string): SelectorGenerator<Task | undefined> {
  return yield* selectFrom(tasksTable, "byId")
    .where((q) => q.eq("id", id))
    .first();
}

function* saveTask(task: Task): ActionGenerator<void> {
  yield* upsert(tasksTable, [task]);
}
```

A helper annotated as `Generator<unknown, T>` no longer type-checks inside a
handler; switch it to one of the types above. Handlers may only yield HyperDB
commands, so a stray `yield value` is also a type error. The yield unions
themselves are exported as `SelectorCommand` and `ActionCommand`.

## Errors

Runtime errors extend `HyperDBError` and carry a stable `code`. Match on the
code rather than the message text. `isHyperDBError(error, code)` narrows the
error and also recognizes errors raised by another copy of the package in the
same bundle. Mistakes in how tables, actions, or queries are defined (such as a
blank action name, an invalid index, or conflicting query conditions) throw a
plain `Error`, for which `isHyperDBError` returns `false`.

```ts
import { DuplicateIdError, isHyperDBError } from "@will-be-done/hyperdb";

try {
  await asyncDispatch(db, createTask(args));
} catch (error) {
  if (error instanceof DuplicateIdError) console.warn("exists:", error.id);
  else if (isHyperDBError(error, "VALIDATION")) showFormError(error.message);
  else throw error;
}
```

| Code                      | Raised when                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `DUPLICATE_ID`            | `insert` hits an existing id (`DuplicateIdError`, with `id`)                 |
| `VALIDATION`              | Args or rows fail their validators (`ValidationError`)                       |
| `WRITES_DISALLOWED`       | A selector tries to write                                                    |
| `TRANSACTION_FINISHED`    | A transaction is used after commit or rollback                               |
| `READONLY_TRANSACTION`    | A write goes through a readonly transaction                                  |
| `TABLE_NOT_FOUND`         | A table was not passed to `loadTables`                                       |
| `INDEX_NOT_FOUND`         | A query names an index the table does not declare                            |
| `ASYNC_IN_SYNC_EXECUTION` | A sync helper (`execSync`, `syncDispatch`, `selectSync`) meets async storage |
| `UNSUPPORTED_COMMAND`     | A handler yields something that is not a HyperDB command                     |
| `PERSISTENCE_QUEUE_FULL`  | Hybrid persistence is at capacity; await `waitForPersistence()` and retry    |
| `HYBRID_DB_CRASHED`       | Background persistence failed permanently (`HybridDBCrashedError`)           |
| `UNDO_CONFLICT`           | Undo/redo would overwrite a newer change (`UndoConflictError`)               |
| `DB_CLOSED`               | The runtime was closed with `close()`                                        |

HyperDB does not log errors it throws; they reach the caller of the dispatch or
select helper, or the `error` state of async selector stores and
`useAsyncSelector`.
Every driver reports a primary-key collision as `DuplicateIdError`, including
a repeated id inside one batch. Other storage-engine errors, such as a SQLite or
IndexedDB `uniqhash` violation, are passed through unchanged.

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

### Handling failed commands

When a read or write fails, its error is raised at the handler's `yield*`, so
ordinary `try` / `catch` / `finally` works inside actions and selectors. An
error the handler does not catch rolls the transaction back.

```ts
import { DuplicateIdError, insert, upsert, v } from "@will-be-done/hyperdb";

export const ensureTask = action({
  name: "ensureTask",
  args: { task: v.pass<Task>() },
  handler: function* ({ task }) {
    try {
      yield* insert(tasksTable, [task]);
    } catch (error) {
      if (!(error instanceof DuplicateIdError)) throw error;
      yield* upsert(tasksTable, [task]); // already exists: update instead
    }
  },
});
```

A failed write has no partial effect, so the action can continue after catching
it. Two cases still end the transaction:

- A failed IndexedDB request aborts the whole browser transaction, so the
  dispatch rejects even if the handler caught the error, and nothing is
  committed. Duplicate ids are still reported as `DuplicateIdError`. With
  `HybridDB`, writes are checked against the in-memory cache first, so
  duplicates and constraint errors can be handled.
- Mutation hooks (`afterInsert`, `afterChange`, ...) run after their write is
  applied. If one fails, the handler sees the error, but the transaction can no
  longer commit: the dispatch rejects with the hook's error, nothing is written,
  and subscribers are not notified.

When you dispatch against a [`SubscribableDB`](/runtime/db/), the commit bumps a
revision and notifies subscribers with the exact rows that changed. This is what
drives reactive selectors and the `afterInsert` / `afterUpsert` / `afterDelete` /
`afterChange` mutation hooks. `SubscribableDB` also exposes `afterScan` for
successful reads.

## Undo and redo

The optional [undo plugin](/integrations/undo/) records committed transactions
for selected tables. Its scoped `withoutUndo` helpers exclude individual writes
inside an action, either for one manager or for every manager. Excluded writes
still commit atomically with the rest of the action and notify subscribers.
Run undo/redo outside actions with `execSync(history.undo())` or
`await execAsync(history.undo())`.

## Bulk writes

`insert`, `upsert`, and `deleteRows` all take arrays, so batch your writes
into a single command rather than looping.
