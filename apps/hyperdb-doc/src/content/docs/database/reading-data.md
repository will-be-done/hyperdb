---
title: Reading Data
description: Query data with selectors and the selectFrom builder — filters, ordering, limits, and first results.
sidebar:
  order: 3
---

You read data through **selectors** — generator functions that describe what to
read. Inside a selector you build queries with `selectFrom` and `yield*` them.
Selectors can call other selectors but can never write; the runtime rejects any
mutation emitted from a read.

## A first selector

```ts
import { selectFrom, v } from "@will-be-done/hyperdb-lib";
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

| Field | Description |
| --- | --- |
| `name` | Required display/debug name (shown in traces) |
| `args` | Validator map for the single args object |
| `handler` | Generator function that does the reading |
| `skipTrace` | `true`, or `{ rootTrace, childTrace }` to skip tracing |
| `memoization` | `{ root?, selfChild? }` cache controls — see [Selectors & Reactivity](/database/selectors-reactivity/) |

You can also wrap a bare generator function instead of using the object form.

## The query builder

`selectFrom(table, indexName)` returns a builder. You always query **through an
index** — there are no table scans. The builder is immutable: each method returns
a new builder.

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

| Method | Meaning |
| --- | --- |
| `q.eq(col, val)` | equal to |
| `q.gt(col, val)` | greater than |
| `q.gte(col, val)` | greater than or equal |
| `q.lt(col, val)` | less than |
| `q.lte(col, val)` | less than or equal |

Comparisons apply to **index columns**, and which combinations are legal depends
on the column order of the index. The rules (equality prefix + one trailing
range) are explained in detail in [Indexes](/database/indexes/).

### OR queries

To express an OR, return an **array** of query branches from `where`, or use the
`or(...)` helper. Each branch is scanned and the results are combined.

```ts
import { selectFrom, or } from "@will-be-done/hyperdb-lib";

selectFrom(tasksTable, "byProjectState")
  .where((q) => or(
    q.eq("projectId", "p1").eq("state", "todo"),
    q.eq("projectId", "p2"),
  ));

// equivalent, returning an array directly:
selectFrom(tasksTable, "byProjectState")
  .where((q) => [
    q.eq("projectId", "p1").eq("state", "todo"),
    q.eq("projectId", "p2"),
  ]);
```

This is the idiom for batched lookups — for example fetching many rows by id in
one query:

```ts
selectFrom(tasksTable, "byId").where((q) => ids.map((id) => q.eq("id", id)));
```

### `order` and `limit`

```ts
.order("asc")   // or "desc" — follows the index's key order
.limit(50)      // cap the number of returned rows
```

Ordering follows the B-tree index's natural key order; `"desc"` walks it in
reverse. Hash indexes are for equality lookups and do not provide ordering.

## Retrieving results

### Many rows

`yield*`-ing a query returns an **array** of rows:

```ts
const tasks = yield* selectFrom(tasksTable, "byProjectOrder")
  .where((q) => q.eq("projectId", projectId));
```

### The first row

`first()` returns the first matching row or `undefined`. `firstOr(fallback)`
returns a fallback instead of `undefined`.

```ts
const task = yield* selectFrom(tasksTable, "byId")
  .where((q) => q.eq("id", taskId))
  .first();

const stateOrDefault = yield* selectFrom(tasksTable, "byId")
  .where((q) => q.eq("id", taskId))
  .firstOr({ id: taskId, state: "todo" } as Task);
```

Both apply a `limit(1)` internally, so they stop after the first match.

## Composing selectors

Selectors call other selectors with `yield*`, which lets you build larger reads
from smaller ones. The runtime tracks the index ranges scanned across the whole
tree, so a composed selector stays just as precisely reactive as its parts.

```ts
const projectSummary = selector({
  name: "projectSummary",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    const tasks = yield* projectTasks({ projectId });
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.state === "done").length,
    };
  },
});
```

## Running selectors

Inside React, use [`useSyncSelector` / `useAsyncSelector`](/integrations/react/).
Outside React, run them directly:

```ts
import { select, runSelectorAsync } from "@will-be-done/hyperdb-lib";

// synchronous drivers (in-memory, sync SQLite)
const tasks = select(db, projectTasks({ projectId: "p1" }));

// asynchronous drivers (IndexedDB, async SQLite)
const tasksAsync = await runSelectorAsync(db, () => projectTasks({ projectId: "p1" }));
```

For cached, subscribed reads outside React, see
[`initCachedSelector`](/database/selectors-reactivity/#caching-a-selector).
