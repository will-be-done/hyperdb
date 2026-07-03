---
title: Data Types
description: The value types HyperDB can store and index, and how undefined is handled.
sidebar:
  order: 2
---

HyperDB stores a fixed set of JavaScript value types. Validators serve three
jobs at once:

- infer TypeScript types for rows, selector args, and action args;
- normalize values before they reach a storage driver;
- tell HyperDB which fields can be compared and indexed.

The storage drivers all see normalized values, so the same schema behaves the
same way in memory, IndexedDB, and SQLite.

## Supported values

| Validator              | TypeScript type  | Notes |
| ---------------------- | ---------------- | ----- |
| `v.string()`           | `string`         | |
| `v.number()`           | `number`         | Finite only; `NaN`, `Infinity`, and `-Infinity` are rejected |
| `v.bigint()`           | `bigint`         | Preserved by the SQLite and IndexedDB storage codecs |
| `v.boolean()`          | `boolean`        | |
| `v.null()`             | `null`           | Use this for explicitly empty values |
| `v.literal(x)`         | the literal      | `x` may be a `string`, `number`, `bigint`, `boolean`, or `null` |
| `v.array(item)`        | `T[]`            | Every item is normalized with `item`; `undefined` is rejected |
| `v.object(fields)`     | `{ ... }`        | Rejects unknown fields; optional fields may be omitted |
| `v.record(key, value)` | `Record<K, V>`   | Keys must be non-empty ASCII strings that do not start with `$` |
| `v.union(...)`         | a union          | Validators are tried in order; the first matching variant wins |
| `v.optional(inner)`    | `T \| undefined` | For object fields; `undefined` normalizes to the field being omitted |
| `v.arrayBuffer()`      | `ArrayBuffer`    | Typed arrays and `DataView`s are accepted and copied to an `ArrayBuffer` |
| `v.any()`              | `any`            | Accepts any structurally storable value; use sparingly |
| `v.pass<T>()`          | `T`              | Bypasses validation and normalization; for trusted non-storage values |

### Composite helpers

- `v.partial(objectValidator)`: every field becomes optional.
- `v.required(objectValidator, keys)`: make listed optional fields required.
- `v.lazy(() => validator)`: defer resolution, useful for recursion.

## Normalization rules

Normalization runs before a row is written and whenever runtime row validation
is enabled for driver reads. Important rules:

- Object validators are exact. Extra fields are rejected, not silently dropped.
- Object and schema keys cannot be empty or start with `$`.
- Record keys must also be ASCII.
- Optional object fields may be omitted, and `{ field: undefined }` is stored as
  if the field was not present.
- Arrays and records cannot contain `undefined`.
- `v.optional(...)` is for object fields. Optional array items or record values
  are rejected if they normalize to `undefined`.
- Typed-array and `DataView` values passed to `v.arrayBuffer()` are copied into
  a fresh `ArrayBuffer`, so later mutations to the original view do not mutate
  the normalized value.

```ts
import { assertValid, v } from "@will-be-done/hyperdb";

const taskValidator = v.object({
  id: v.string(),
  title: v.string(),
  note: v.optional(v.string()),
});

const normalized = assertValid(taskValidator, {
  id: "t1",
  title: "Ship",
  note: undefined,
});
// { id: "t1", title: "Ship" }

assertValid(taskValidator, { id: "t1", title: "Ship", extra: true });
// throws: unexpected object field extra
```

## Binary data

`v.arrayBuffer()` accepts an `ArrayBuffer` directly, and also accepts any typed
array or `DataView`, which are copied into a fresh `ArrayBuffer` during
normalization. Storage drivers encode binary data appropriately:

- The SQLite drivers encode `bigint`, `ArrayBuffer`, and typed-array/data-view
  values around JSON storage.
- The IndexedDB driver uses the same storage encoding and sort-key ordering
  as SQLite.
- The in-memory driver stores normalized JS values directly.

## Indexable values

Not every value can appear in an index. Indexable value types are:

- `string`, finite `number`, `bigint`, `boolean`, `null`
- `ArrayBuffer` and typed-array / `DataView` values
- `v.literal(...)` of an indexable primitive
- `v.union(...)` where every variant is indexable
- `v.optional(...)` of an indexable value

If you try to build an index on a non-indexable column (an `array`, `object`,
`record`, or `any`), `defineTable` throws. See [Indexes](/database/indexes/).

## The `v.any()` validator

`v.any()` accepts arbitrary storable structures while still enforcing HyperDB's
storage rules: numbers must be finite, object keys cannot be empty or start with
`$`, arrays cannot contain `undefined`, and unsupported objects such as `Date`,
`Map`, and class instances are rejected.

Use it for metadata or imported payloads whose shape is intentionally open. For
core app data, prefer explicit validators so you keep useful TypeScript types
and indexable fields.

## The `v.pass<T>()` validator

`v.pass<T>()` accepts anything and returns it unchanged. It is useful for
selector/action arguments or intermediate values when you already trust the
shape and do not want runtime normalization.

Avoid `v.pass<T>()` in table schemas unless you are certain the value is safe for
the storage driver. It can let non-storable values through because it deliberately
skips HyperDB's normal storage checks.

## Working with `undefined`

`undefined` is not a storable value. The rules:

- An optional object field may be omitted. Writing `{ note: undefined }` is
  normalized to the field being absent, so it round-trips as missing, not as
  `undefined`.
- `undefined` is not allowed inside an array (`[1, undefined]` is rejected).
- `undefined` is not allowed as a record value.

If you need to represent "explicitly empty", model it with `v.null()` instead of
relying on `undefined`.

```ts
const taskFields = {
  id: v.string(),
  note: v.optional(v.string()),
  deletedAt: v.union(v.number(), v.null()),
};

const missingNote = { id: "t1", deletedAt: null };

const explicitlyEmptyDeletedAt = {
  id: "t1",
  note: "hello",
  deletedAt: null,
};
```

## Dates, times, and other rich types

There is no dedicated date type. Store timestamps as `string` (ISO-8601 sorts
lexicographically, which works well with B-tree indexes) or as a `number` /
`bigint` of epoch milliseconds. Reconstruct `Date` objects in your application
code as needed.

```ts
const eventsTable = defineTable("events", {
  id: v.string(),
  createdAt: v.string(), // e.g. new Date().toISOString()
}).index("byCreatedAt", ["createdAt"]);
```
