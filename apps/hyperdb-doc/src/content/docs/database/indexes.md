---
title: Indexes
description: B-tree and hash indexes, composite keys, and the prefix rules that govern which queries are valid.
sidebar:
  order: 4
---

Every query runs **through an index** — HyperDB never does a full table scan.
Indexes are declared on the table and determine which filters and orderings are
possible.

## Declaring indexes

```ts
defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"]) // composite btree
  .index("byState", ["state"], { type: "hash" });        // single-column hash
```

The built-in `byId` hash index on `id` is always present — you never declare it.

### B-tree vs. hash

| | B-tree (default) | Hash |
| --- | --- | --- |
| Equality (`eq`) | ✅ | ✅ |
| Range (`gt`/`gte`/`lt`/`lte`) | ✅ | ❌ |
| `order("asc" \| "desc")` | ✅ | ❌ |
| Composite (multi-column) | ✅ | ❌ (exactly one column) |

Reach for a **hash** index when you only ever look up a column by exact value;
use a **btree** index when you need ranges, ordering, or multi-column keys.

### What can be indexed

Index columns must be [indexable value types](/database/data-types/#indexable-values)
and must exist in the schema. Index definitions are validated at `defineTable`
time, so an illegal index throws immediately rather than failing at query time.

## Querying a composite index

A composite B-tree index stores rows ordered by its columns left to right, like a
phone book ordered by `(lastName, firstName)`. That ordering dictates which
filters are valid. Two rules:

1. **Equality prefix.** You may constrain a column only if **every** column
   before it in the index is constrained by equality (`eq`).
2. **One trailing range.** After the equality prefix, you may apply a single
   range (`gt`/`gte`/`lt`/`lte`) on the next column. You cannot range on a column
   and then constrain a later one.

For `byProjectOrder` = `["projectId", "orderToken"]`:

```ts
// ✅ equality on the prefix
.where((q) => q.eq("projectId", "p1"))

// ✅ equality prefix + range on the next column
.where((q) => q.eq("projectId", "p1").gte("orderToken", "m"))

// ✅ equality on both columns
.where((q) => q.eq("projectId", "p1").eq("orderToken", "m"))

// ❌ skips the prefix: orderToken constrained without eq on projectId
.where((q) => q.gte("orderToken", "m"))
```

### Things that throw

The query builder validates bounds when the query is constructed and will throw
for:

- **A non-prefix column** — using a column without `eq` on all preceding columns
  (`Cannot use column 'X' without specifying eq conditions for all preceding
  columns`).
- **`eq` mixed with a range on the same column** — e.g. `eq("c", 1).gt("c", 0)`
  (`Conflicting conditions for column 'c'`).
- **Two equality conditions on one column** (`Multiple equality conditions`).
- **A column that isn't in the index** (`Column 'X' not found in index`).
- **No usable conditions** at all.

### Effective equality

A column constrained by both `gte` and `lte` with the **same value** is treated
as an equality for prefix purposes. So `q.gte("projectId", "p1").lte("projectId",
"p1").gte("orderToken", "m")` is a valid equality-prefix-plus-range query.

## Ordering with indexes

Because a B-tree index is physically ordered, `order("asc")` returns rows in the
index's key order and `order("desc")` returns them reversed — no separate sort
step. Choose your index column order to match how you want to read the data. For
the `byProjectOrder` index, tasks come back ordered by `orderToken` within a
project for free.

## Designing indexes

- Put the columns you filter by **equality** first, and the column you **range or
  order** by last.
- A single composite index often serves several queries — a query that constrains
  only `projectId` and a query that constrains `projectId` + an `orderToken`
  range can share `byProjectOrder`.
- Use `string` order tokens (e.g. fractional-index strings) when you need stable,
  insertable ordering without renumbering siblings.
