---
title: Schemas
description: Define tables, validators, indexes, and tagged unions with defineTable and v.
sidebar:
  order: 1
---

A schema describes the **shape of your rows** and the **indexes** you can query
by. Schemas are defined with `defineTable` and the `v` validator library, and
they double as the source of truth for TypeScript types.

## Defining a table

Every table has a name and a set of fields. A table **must** have a string `id`
field. HyperDB automatically creates a built-in hash index named `byId` on `id`.

```ts
import { defineTable, v, type ExtractSchema } from "@will-be-done/hyperdb-lib";

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  orderToken: v.string(),
  note: v.optional(v.string()),
})
  .index("byProjectOrder", ["projectId", "orderToken"])
  .index("byTitle", ["title"], { type: "hash" });

export type Task = ExtractSchema<typeof tasksTable>;
```

`ExtractSchema<typeof table>` gives you the row type — here, `Task` is:

```ts
type Task = {
  id: string;
  projectId: string;
  title: string;
  state: "todo" | "done";
  orderToken: string;
  note?: string;
};
```

Tables are plain descriptions. They don't store data and aren't bound to any
database, so you can import the same table into multiple `DB` instances. You make
a table usable on a database by calling [`loadTables`](/runtime/db/).

## Validators

Fields are described with validators from the `v` namespace. The full list of
value types lives in [Data Types](/database/data-types/); here are the building
blocks:

```ts
v.string();
v.number();          // finite numbers only
v.bigint();
v.boolean();
v.null();
v.literal("done");   // string | number | bigint | boolean | null literals
v.array(v.string());
v.object({ x: v.number(), y: v.number() });
v.record(v.string(), v.number());
v.union(v.literal("todo"), v.literal("done"));
v.optional(v.string());
v.arrayBuffer();
v.any();
```

There are also helpers for deriving object validators:

- `v.partial(objectValidator)` — make every field optional.
- `v.required(objectValidator, ["a", "b"])` — make the listed optional fields
  required again.
- `v.lazy(() => validator)` — defer evaluation, for recursive shapes.
- `v.pass<T>()` — accept any value as type `T` without normalizing it.

## Standalone validators and types

Validators are useful beyond tables — for example to type selector/action
arguments or intermediate data. Use `Infer` to get the TypeScript type of any
validator.

```ts
import { v, type Infer } from "@will-be-done/hyperdb-lib";

const filterSchema = v.object({
  projectId: v.string(),
  state: v.optional(v.union(v.literal("todo"), v.literal("done"))),
});

type Filter = Infer<typeof filterSchema>;
// { projectId: string; state?: "todo" | "done" }
```

## Tagged unions

`defineTable` also accepts a standalone object or union validator instead of a
field map. This is how you model a table whose rows are a **tagged union** of
several shapes:

```ts
const documentsTable = defineTable(
  "documents",
  v.union(
    v.object({ id: v.string(), type: v.literal("post"), title: v.string() }),
    v.object({ id: v.string(), type: v.literal("note"), body: v.string() }),
  ),
).index("byPostTitle", ["title"]);
```

Each variant must still include a string `id`. When you index a column, HyperDB
collects that field's validator across every variant that declares it.

## Indexes

Indexes are declared with `.index(name, columns, options?)` and are what make
queries fast. Each `.index(...)` call returns a new table definition, so you can
chain them.

```ts
defineTable("tasks", { /* fields */ })
  .index("byProjectOrder", ["projectId", "orderToken"]) // btree (default)
  .index("byTitle", ["title"], { type: "hash" });        // hash
```

- **`btree`** (the default) supports equality *and* range queries, ordering, and
  composite (multi-column) keys.
- **`hash`** supports equality lookups only and must have **exactly one column**.

Index columns must:

- exist in the table schema, and
- be **indexable** value types (`string`, finite `number`, `bigint`, `boolean`,
  `null`, `ArrayBuffer`/typed-array, and compatible literals, unions, and
  optionals of those).

Invalid index definitions throw at `defineTable` time, so mistakes surface
immediately. For how composite indexes are queried, see
[Indexes](/database/indexes/).

## The `undefined` rule

Stored values can never contain `undefined`. Optional **object fields** may be
omitted entirely, and `{ field: undefined }` is normalized to "missing". But
`undefined` is not allowed inside arrays or as a record value. See
[Data Types](/database/data-types/#working-with-undefined) for the details.

## Type helpers reference

| Helper | Purpose |
| --- | --- |
| `ExtractSchema<typeof table>` | Row type of a table |
| `ExtractIndexes<typeof table>` | Index definitions of a table |
| `Infer<typeof validator>` | TypeScript type of any validator |
| `InferObject<fields>` | TypeScript type of an object field map |
