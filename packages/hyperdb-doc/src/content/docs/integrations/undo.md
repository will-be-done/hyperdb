---
title: Undo & Redo
description: Transaction history, scoped recording exclusions, grouping, and safe replay.
sidebar:
  order: 3
---

`undoMiddleware` attaches an in-memory undo manager to a `SubscribableDB`.
Each committed transaction that changes a tracked table creates one undo step.
Nested actions share their parent's transaction and undo together.

```ts
import {
  execSync,
  execAsync,
  syncDispatch,
  asyncDispatch,
} from "@will-be-done/hyperdb";
import { undoMiddleware } from "@will-be-done/hyperdb/undo";

const history = undoMiddleware(db, {
  tables: [tasksTable, projectsTable],
  maxUndoLevels: 100,
  maxRedoLevels: 100,
});

syncDispatch(db, renameTask({ id: "t1", title: "Updated" }));
execSync(history.undo());
execSync(history.redo());

// With IndexedDB, async SQLite, HybridDB, or PreloadedHybridDB:
await execAsync(history.undo());
```

Create managers before edits you want to record. All tracked writes must go
through the same `SubscribableDB` or its trait views. Writes through its wrapped
runtime bypass history and subscriptions. Failed transactions, reads, and
transactions with no effective tracked changes do not create history entries.

`undo()` and `redo()` manage their own transactions. Execute them with
`execSync` or `execAsync`, outside an action; do not pass them to a dispatcher.
Replay restores captured rows without rerunning the original action, so IDs and
other generated values stay the same. With `HybridDB`, replay follows its usual
cache-first commit and background persistence behavior.

## Manager API

- `store`: a read-only view of the manager's in-memory queues. It is not a
  persistence adapter.
- `undoQueue`, `redoQueue`: read-only snapshots, with the next operation last.
  Each event has an optional `name` and ordered `changes`. Each change has its
  mutation `type`, `table`, `id`, `before`, and `after`; `undefined` means the
  row was absent. Returned row values are copied so callers cannot alter history.
- `undoLevels`, `redoLevels`, `canUndo`, `canRedo`: history availability.
- `undo()`, `redo()`: transaction generators; throw when their queue is empty.
- `clearUndo()`, `clearRedo()`: clear one queue.
- `withoutUndo(...)`: exclude a scope from this manager.
- `withGroup(...)`, `createGroup(name?)`: combine transactions into one step.
- `subscribe(listener)`: subscribe to history changes; returns an unsubscribe
  function. `getRevision()` returns a primitive snapshot for reactive adapters
  such as `useSyncExternalStore`.
- `dispose()`: detach recording and clear subscribers. Disposing twice is safe;
  later manager operations throw. Existing queue snapshots remain readable.

`tables` is required. Limits are optional and unlimited by default; each must
be a non-negative safe integer. Zero disables retention in that queue. A new
recorded edit clears redo. Excluded edits do not clear redo, but can cause a
conflict when replayed later.

## Exclude writes inside actions

Use generator blocks with `yield*`. The manager method excludes only that
manager; the imported helper excludes every manager.

```ts
import { insert, upsert } from "@will-be-done/hyperdb";
import { withoutUndo } from "@will-be-done/hyperdb/undo";

function* edit() {
  yield* upsert(tasksTable, [updatedTask]); // recorded

  yield* history.withoutUndo(function* () {
    yield* upsert(preferencesTable, [preferences]); // this manager skips it
  });

  const id = yield* withoutUndo(function* () {
    yield* insert(sessionTable, [session]); // every manager skips it
    return session.id;
  });

  yield* upsert(projectsTable, [updatedProject]); // recorded again
  return id;
}
```

Nested actions and their mutation hooks inherit exclusions. Nested exclusions
combine. Recording resumes after the block, and errors roll back the dispatch
normally. The scope stays local to that execution, including during asynchronous
driver work. Excluded writes still validate, persist, and notify subscribers.

History restores complete rows. Exclusion is not field-level selective undo:
mixing excluded and recorded updates to the same row can make that step
conflict. Prefer separate rows or tables for state that should not be undone.

## Exclude writes outside actions

Callback helpers provide a DB view. All excluded writes must use that view.
The helpers preserve callback return values and can return a promise.

```ts
history.withoutUndo((scopedDb) => {
  syncDispatch(scopedDb, loadInitialData(data));
});

await withoutUndo(db, async (scopedDb) => {
  const changes = await fetchChanges();
  await asyncDispatch(scopedDb, applyRemoteChanges(changes));
});
```

Using the original `db` inside these callbacks records writes normally.

## Group transactions

```ts
history.withGroup("Move tasks", (scopedDb) => {
  syncDispatch(scopedDb, moveTask(first));
  history.withGroup((nestedDb) => {
    syncDispatch(nestedDb, moveTask(second));
  });
});
```

Nested groups join the outer group. Callback return values are preserved.
Blocks must be synchronous. Grouping affects history only: each dispatch still
commits separately. If a later block throws, earlier committed changes remain
and are retained in the group. Compose actions into a single dispatch when you
need atomic changes.

Use a manual group for separate synchronous blocks, such as drag updates:

```ts
const group = history.createGroup("Drag task");
try {
  group.continue((scopedDb) => syncDispatch(scopedDb, moveTask(first)));
  const next = await computeNextPosition();
  group.continue((scopedDb) => syncDispatch(scopedDb, moveTask(next)));
} finally {
  group.end();
}
```

Only writes through a group's provided DB view join it. An unrelated recorded
transaction automatically closes an open group before adding its own history
entry; continuing the closed group throws. This preserves chronological order.
End an open group before undoing, redoing, clearing queues, or opening another
group. Ending an already closed group is safe. Async dispatches cannot be used
inside `withGroup` or `group.continue`; dispatch a composed action for one async
transaction instead. This version has no `withGroupFlow` helper.

## Mutation hooks and derived data

Track domain tables and leave hook-maintained counters, caches, and sync
bookkeeping out of `tables`. Mutation hooks run normally during replay and can
rebuild that derived data within the same transaction. Replay is excluded from
recording in all managers, but still notifies DB subscribers.

Hooks that also change tracked domain rows should recognize replay to avoid
duplicating changes already present in the history entry:

```ts
import { isUndoReplay } from "@will-be-done/hyperdb/undo";

db.afterChange(function* (_db, table, traits, ops) {
  if (isUndoReplay(traits)) return;
  // Perform domain changes that history already captures during normal edits.
});
```

Treat rows and operation data as immutable. Hooks that derive data from normal
mutations can be registered before or after the manager.

## Conflicts

Before replay, the manager checks expected current rows inside its transaction.
If an excluded write, remote change, or another manager has changed a row,
replay throws `UndoConflictError` with `tableName` and `rowId`. It also checks
that hooks leave replayed rows in their expected final state. On failure, data
rolls back and neither queue moves. Hook, validation, and storage failures also
leave history in place.

Conflict checks compare entire rows, including nested values, bigint, and binary
contents. They do not merge concurrent edits. Resolve the conflict or clear the
affected queue before continuing. History is kept only in memory; persisted
history and attached cursor/selection state are not supported yet.
