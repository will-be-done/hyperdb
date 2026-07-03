---
title: Reading Data
description: Query data with selectors and the selectFrom builder, covering filters, ordering, limits, and first results.
sidebar:
  order: 3
---

You read data through selectors, generator functions that describe what to
read. Inside a selector you build queries with `selectFrom` and `yield*` them.
Selectors can call other selectors but can never write; the runtime rejects any
mutation emitted from a read.

Every read starts from a named index. That makes the access path explicit in
your application code: `selectFrom(tasksTable, "byProjectOrder")` means "scan
this table through this index", then `.where(...)`, `.order(...)`, and
`.limit(...)` describe the bounds and result shape.

## A first selector

```ts
import { selectFrom, v } from "@will-be-done/hyperdb";
import { selector } from "./builders"; // createSelector()
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
```

Object-form selectors accept:

| Field         | Description                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `name`        | Required display/debug name (shown in traces)                                                          |
| `args`        | Validator map for the single args object                                                               |
| `handler`     | Generator function that does the reading                                                               |
| `skipTrace`   | `true`, or `{ rootTrace, childTrace }` to skip tracing                                                 |
| `memoization` | `{ root?, selfChild? }` cache controls (see [Selectors & Reactivity](/database/selectors-reactivity/)) |

You can also wrap a bare generator function instead of using the object form.

## The query builder

`selectFrom(table, indexName)` returns a builder. You always query through an
index. The builder is immutable: each method returns a new builder. With
`HybridDB`, the same indexed read checks the in-memory cache first; missing
ranges fall through to the primary store and are cached for later reads.

```ts
selectFrom(tasksTable, "byProjectOrder")
  .where((q) => q.eq("projectId", "p1"))
  .order("desc")
  .limit(20);
```

### `where`

`where` takes a callback that receives a query object. Chain comparison methods
on it; each column you constrain must belong to the index you selected.

```ts
.where((q) => q.eq("projectId", "p1"))
.where((q) => q.eq("projectId", "p1").gte("orderToken", "m"))
```

Available comparisons:

| Method            | Meaning               |
| ----------------- | --------------------- |
| `q.eq(col, val)`  | equal to              |
| `q.gt(col, val)`  | greater than          |
| `q.gte(col, val)` | greater than or equal |
| `q.lt(col, val)`  | less than             |
| `q.lte(col, val)` | less than or equal    |

Comparisons apply to index columns, and which combinations are legal depends
on the column order of the index. The rules (equality prefix + one trailing
range) are explained in detail in [Indexes](/database/indexes/).

### OR queries

To express an OR, return an array of query branches from `where`, or use the
`or(...)` helper. Each branch is scanned and the results are combined.
With `.order(...)`, the combined rows are ordered by the index globally, not by
the order of the OR branches.

```ts
import { selectFrom, or } from "@will-be-done/hyperdb";

selectFrom(tasksTable, "byProjectState").where((q) =>
  or(q.eq("projectId", "p1").eq("state", "todo"), q.eq("projectId", "p2")),
);

// equivalent, returning an array directly:
selectFrom(tasksTable, "byProjectState").where((q) => [
  q.eq("projectId", "p1").eq("state", "todo"),
  q.eq("projectId", "p2"),
]);
```

This is the idiom for batched lookups, for example fetching many rows by id in
one query:

```ts
selectFrom(tasksTable, "byId").where((q) => ids.map((id) => q.eq("id", id)));
```

When reads go through a [`SubscribableDB`](/runtime/db/), `afterScan` lifecycle
hooks can observe each successful scan with the table, index, where clauses,
select options, and returned rows.

### `order` and `limit`

```ts
.order("asc")   // or "desc"; follows the index's key order
.limit(50)      // cap the number of returned rows
```

Ordering follows the B-tree index's natural key order; `"desc"` walks it in
reverse. Hash indexes are for equality lookups and do not provide ordering.

## Retrieving results

### Many rows

`yield*`-ing a query returns an array of rows:

```ts
const tasks =
  yield *
  selectFrom(tasksTable, "byProjectOrder").where((q) =>
    q.eq("projectId", projectId),
  );
```

### The first row

`first()` returns the first matching row or `undefined`. `firstOr(fallback)`
returns a fallback instead of `undefined`.

```ts
const task =
  yield *
  selectFrom(tasksTable, "byId")
    .where((q) => q.eq("id", taskId))
    .first();

const stateOrDefault =
  yield *
  selectFrom(tasksTable, "byId")
    .where((q) => q.eq("id", taskId))
    .firstOr({ id: taskId, state: "todo" } as Task);
```

Both apply a `limit(1)` internally, so they stop after the first match.

## Composing selectors

Selectors call other selectors with `yield*`, which lets you build larger reads
from smaller ones. The runtime tracks the index ranges scanned across the whole
tree, so a composed selector stays just as precisely reactive as its parts.

```ts
import { selectFrom, v } from "@will-be-done/hyperdb";
import { selector } from "./builders"; // createSelector()
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

const projectDoneTasks = selector({
  name: "projectDoneTasks",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    return yield* selectFrom(tasksTable, "byProjectState").where((q) =>
      q.eq("projectId", projectId).eq("state", "done"),
    );
  },
});

const projectSummary = selector({
  name: "projectSummary",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    const tasks = yield* projectTasks({ projectId });
    const doneTasks = yield* projectDoneTasks({ projectId });
    return {
      total: tasks.length,
      done: doneTasks.length,
    };
  },
});
```

In that example, `projectDoneTasks` should use an index such as
`byProjectState = ["projectId", "state"]` instead of filtering the full project
list in JavaScript. Composition keeps code ergonomic, but each selector should
still choose the index that matches the data it needs.

## Running selectors

Inside React, use [`useSyncSelector` / `useAsyncSelector`](/integrations/react/).
Outside React, run them directly:

```ts
import { selectAsync, selectSync } from "@will-be-done/hyperdb";

// synchronous drivers (in-memory, sync SQLite)
const tasks = selectSync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});

// asynchronous drivers (IndexedDB, async SQLite, HybridDB)
const tasksAsync = await selectAsync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
```

For cached, subscribed reads outside React, see
[`createCachedSelectorStoreSync`](/database/selectors-reactivity/#caching-a-selector).

### Lower-level runner helpers

`selectSync` and `selectAsync` are the everyday helpers. HyperDB also exports
cache-aware runners and store creators from `@will-be-done/hyperdb` for
integrations, custom stores, and preload flows:

| Helper                          | Use                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| `selectSync`                    | Run a selector once with sync drivers                                |
| `selectAsync`                   | Run a selector once with async drivers and `HybridDB`                |
| `selectMaybeAsync`              | Return a value or a `Promise`, depending on whether execution yields |
| `createSelectorStoreSync`       | Create a sync subscribed store with `subscribe()` / `getSnapshot()`  |
| `createCachedSelectorStoreSync` | Create a sync subscribed store backed by the root selector cache     |
| `runCachedSelectorSync`         | Run or reuse the root selector cache synchronously                   |
| `runCachedSelectorAsync`        | Async cache-aware selector runner                                    |
| `runCachedSelectorMaybeAsync`   | Cache-aware runner that may return a value or a `Promise`            |

Use `createSelectorStoreSync` when you want a small synchronous external store for one
selector run:

```ts
import { createSelectorStoreSync } from "@will-be-done/hyperdb";

const store = createSelectorStoreSync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
const unsubscribe = store.subscribe(() => {
  console.log(store.getSnapshot());
});
```

Use `createCachedSelectorStoreSync` when you want the same store shape but backed by the
root selector cache, so repeated calls for the same selector and args can reuse
the cached result:

```ts
import { createCachedSelectorStoreSync } from "@will-be-done/hyperdb";

const cached = createCachedSelectorStoreSync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
cached.refresh();
```

For async cache-aware code, use `runCachedSelectorMaybeAsync`. This is the
primitive used by async React reads and preload flows: it reuses a cached result
when possible, and returns a `Promise` when the selector has to fall through to
async storage.

```ts
import { runCachedSelectorMaybeAsync } from "@will-be-done/hyperdb";

const tasksOrPromise = runCachedSelectorMaybeAsync(db, {
  selector: projectTasks,
  args: { projectId: "p1" },
});
const tasks = await Promise.resolve(tasksOrPromise);
```
