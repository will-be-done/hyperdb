---
title: Data Types
description: The value types HyperDB can store and index, and how undefined is handled.
sidebar:
  order: 2
---

HyperDB stores a fixed set of value types. Every value you write is **normalized**
against its validator before it reaches the storage driver, which guarantees that
what comes back out matches your schema.

## Supported values

| Validator | TypeScript type | Notes |
| --- | --- | --- |
| `v.string()` | `string` | |
| `v.number()` | `number` | **Finite only** — `NaN`/`Infinity` are rejected |
| `v.bigint()` | `bigint` | |
| `v.boolean()` | `boolean` | |
| `v.null()` | `null` | |
| `v.literal(x)` | the literal | `x` is a `string`, `number`, `bigint`, `boolean`, or `null` |
| `v.array(item)` | `T[]` | Items cannot be `undefined` |
| `v.object(fields)` | `{ ... }` | Field map; optional fields may be omitted |
| `v.record(key, value)` | `Record<K, V>` | Keys are non-empty ASCII strings not starting with `$` |
| `v.union(...)` | a union | First matching variant wins |
| `v.optional(inner)` | `T \| undefined` | Only meaningful for object fields |
| `v.arrayBuffer()` | `ArrayBuffer` | Typed arrays / data views are accepted and copied to an `ArrayBuffer` |
| `v.any()` | `any` | Validates structurally (see below) |
| `v.pass<T>()` | `T` | Accepts any value, no normalization |

### Composite helpers

- `v.partial(objectValidator)` — every field becomes optional.
- `v.required(objectValidator, keys)` — make listed optional fields required.
- `v.lazy(() => validator)` — defer resolution, useful for recursion.

## Binary data

`v.arrayBuffer()` accepts an `ArrayBuffer` directly, and also accepts any typed
array or `DataView` — these are copied into a fresh `ArrayBuffer` during
normalization. Storage drivers encode binary data appropriately:

- The **SQLite** drivers encode `bigint`, `ArrayBuffer`, and typed-array/data-view
  values around JSON storage.
- The **IndexedDB** driver uses the same storage encoding and sort-key ordering
  as SQLite.
- The **in-memory** driver stores normalized JS values directly.

## Indexable values

Not every value can appear in an index. **Indexable** value types are:

- `string`, finite `number`, `bigint`, `boolean`, `null`
- `ArrayBuffer` and typed-array / `DataView` values
- `v.literal(...)` of an indexable primitive
- `v.union(...)` where **every** variant is indexable
- `v.optional(...)` of an indexable value

If you try to build an index on a non-indexable column (an `array`, `object`,
`record`, or `any`), `defineTable` throws. See [Indexes](/database/indexes/).

## The `v.any()` validator

`v.any()` accepts arbitrary JSON-like structures but still enforces HyperDB's
storage rules: numbers must be finite, object keys cannot be empty or start with
`$`, and `undefined` is rejected inside arrays. Use it sparingly — you lose the
type information and the index-ability that explicit validators give you.

## Working with `undefined`

`undefined` is **not a storable value**. The rules:

- An **optional object field** may be omitted. Writing `{ note: undefined }` is
  normalized to the field being absent — it round-trips as missing, not as
  `undefined`.
- `undefined` is **not allowed inside an array** (`[1, undefined]` is rejected).
- `undefined` is **not allowed as a record value**.

If you need to represent "explicitly empty", model it with `v.null()` instead of
relying on `undefined`.

## Dates, times, and other rich types

There is no dedicated date type. Store timestamps as `string` (ISO-8601 sorts
lexicographically, which works well with B-tree indexes) or as a `number` /
`bigint` of epoch milliseconds. Reconstruct `Date` objects in your application
code as needed.
