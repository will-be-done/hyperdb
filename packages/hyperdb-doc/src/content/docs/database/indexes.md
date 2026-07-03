---
title: Indexes
description: B-tree, hash, and unique hash indexes, composite keys, and the prefix rules that govern which queries are valid.
sidebar:
  order: 4
---

Every query runs through an index. Indexes are declared on the table, named in
`selectFrom(table, "indexName")`, and determine which filters and orderings are
possible. That makes the access path explicit: when you read code, you can see
which index the selector starts from instead of relying on a hidden query
planner.

## Declaring indexes

```ts
defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
  slug: v.string(),
})
  .index("byProjectOrder", ["projectId", "orderToken"]) // composite B-tree
  .index("byIds", ["id"]) // B-tree full-table scan / preload index
  .index("byState", ["state"], { type: "hash" }) // non-unique exact lookup
  .index("bySlug", ["slug"], { type: "uniqhash" }); // unique exact lookup
```

The built-in `byId` unique hash index on `id` is always present, so you never
declare it. If you need to scan or preload a whole table, add a B-tree index
such as `byIds`; the built-in `byId` is optimized for exact id lookups, not
full-table scans.

### B-tree vs. hash

| Capability                    | B-tree (default) | Hash                    | Unique hash             |
| ----------------------------- | ---------------- | ----------------------- | ----------------------- |
| Equality (`eq`)               | Yes              | Yes                     | Yes                     |
| Range (`gt`/`gte`/`lt`/`lte`) | Yes              | No                      | No                      |
| `order("asc" \| "desc")`      | Yes              | No                      | No                      |
| Full-table scan               | Yes              | No                      | No                      |
| Composite (multi-column)      | Yes              | No (exactly one column) | No (exactly one column) |
| Duplicate values              | Yes              | Yes                     | No, driver-enforced     |

Reach for a hash index when you only ever look up a column by exact value;
use a unique hash index when that exact value must identify at most one row.
Use a B-tree index when you need ranges, ordering, ordered full-table scans,
preloading, or multi-column keys.

### What can be indexed

Index columns must be [indexable value types](/database/data-types/#indexable-values)
and must exist in the schema. Index definitions are validated at `defineTable`
time, so an illegal index throws immediately rather than failing at query time.

## Querying a composite index

A composite B-tree index stores rows ordered by its columns left to right, like a
phone book ordered by `(lastName, firstName)`. That ordering dictates which
filters are valid. Two rules:

1. Equality prefix. You may constrain a column only if every column
   before it in the index is constrained by equality (`eq`).
2. One trailing range. After the equality prefix, you may apply a single
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

The shape of the index should follow the shape of the read. For example, a
project task list ordered by fractional index wants:

```ts
.index("byProjectOrder", ["projectId", "orderToken"])
```

Then the selector says exactly what it will scan:

```ts
selectFrom(tasksTable, "byProjectOrder")
  .where((q) => q.eq("projectId", projectId))
  .order("asc");
```

That is a bounded B-tree scan over one project's tasks, already in display
order.

### Things that throw

The query builder validates bounds when the query is constructed and will throw
for:

- A non-prefix column, using a column without `eq` on all preceding columns
  (`Cannot use column 'X' without specifying eq conditions for all preceding
columns`).
- `eq` mixed with a range on the same column, e.g. `eq("c", 1).gt("c", 0)`
  (`Conflicting conditions for column 'c'`).
- Two equality conditions on one column (`Multiple equality conditions`).
- A column that isn't in the index (`Column 'X' not found in index`).
- No usable conditions at all.

## Ordering with indexes

Because a B-tree index is physically ordered, `order("asc")` returns rows in the
index's key order and `order("desc")` returns them reversed, with no separate sort
step. Choose your index column order to match how you want to read the data. For
the `byProjectOrder` index, tasks come back ordered by `orderToken` within a
project for free.

## OR branches

To express an OR, return multiple branches from `where` or use `or(...)`. Each
branch must still obey the same index-prefix rules. HyperDB scans each branch
through the named index and combines the results.

```ts
import { or, selectFrom } from "@will-be-done/hyperdb";

selectFrom(tasksTable, "byProjectOrder").where((q) =>
  or(q.eq("projectId", "p1"), q.eq("projectId", "p2")),
);
```

With `.order(...)`, branch results are merged into the index order before they
are returned.

## Choosing indexes

Start from the selectors your UI and actions need:

- Put equality filters first, in the order that narrows the read.
- Put the ordered or ranged column after the equality prefix.
- Use a hash index for exact lookup by a single non-unique value.
- Use `uniqhash` for slugs, ids from another system, or any exact lookup that
  should return at most one row.
- Add a B-tree full-scan index such as `byIds` when you want to preload or scan
  a whole table.

Avoid adding indexes just because a column exists. Every index makes writes do
more work, because inserts, upserts, and deletes must update each affected index.
