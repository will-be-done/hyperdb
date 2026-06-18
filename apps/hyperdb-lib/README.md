# HyperDB

HyperDB is a small local database API with typed schemas, indexed queries,
generator-based selectors/actions, pluggable storage drivers, React hooks, and a
React devtool.

HyperDB works in three layers:

- Tables define stored row shape and named indexes.
- Queries, selectors, and actions are generator commands that describe reads and
  writes without calling storage directly.
- A `DB` runs those commands against a driver. Drivers provide the actual
  storage backend, such as in-memory B+ trees, SQLite, or IndexedDB.

## Schema

Define tables with `defineTable`. Every table must have a string `id`; HyperDB
also creates a built-in hash index named `byId`.

```ts
import {
  defineTable,
  v,
  type ExtractSchema,
  type Infer,
} from "@will-be-done/hyperdb-lib";

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

For object-shaped schemas that are not tables, use validators directly:

```ts
const filterSchema = v.object({
  projectId: v.string(),
  state: v.optional(v.union(v.literal("todo"), v.literal("done"))),
});

type Filter = Infer<typeof filterSchema>;
```

`defineTable` can also take a standalone object/union validator. This is useful
for tagged unions:

```ts
const documentsTable = defineTable(
  "documents",
  v.union(
    v.object({ id: v.string(), type: v.literal("post"), title: v.string() }),
    v.object({ id: v.string(), type: v.literal("note"), body: v.string() }),
  ),
).index("byPostTitle", ["title"]);
```

Supported validators:

- `v.string()`, `v.number()` finite only, `v.bigint()`, `v.boolean()`, `v.null()`
- `v.literal(value)` for string, number, bigint, boolean, or null literals
- `v.array(item)`, `v.object(fields)`, `v.record(key, value)`
- `v.union(...)`, `v.optional(inner)`, `v.partial(objectValidator)`,
  `v.required(objectValidator, keys)`, `v.arrayBuffer()`, `v.any()`

Stored values cannot contain `undefined`. Optional object fields may be omitted,
and `{ optionalField: undefined }` is normalized as missing. Arrays and records
cannot contain `undefined`.

Indexes are declared with `.index(name, columns, options?)`. `btree` is the
default; `hash` indexes must have exactly one column. Indexable values are
`string`, finite `number`, `bigint`, `boolean`, `null`, `ArrayBuffer`,
typed-array/data-view values, compatible literals, compatible unions, and
optional versions of those values.

## Selectors, Queries, And Actions

A query is built with `selectFrom(table, index)`. It supports `where`, `eq`,
`lt`, `lte`, `gt`, `gte`, `limit`, `order("asc" | "desc")`, `first()`, and
`firstOr(value)`.

```ts
import {
  action,
  insert,
  selectFrom,
  selector,
  syncDispatch,
} from "@will-be-done/hyperdb-lib";

export const projectTasks = selector({
  name: "projectTasks",
  args: { projectId: v.string() },
  handler: function* ({ projectId }) {
    return yield* selectFrom(tasksTable, "byProjectOrder")
      .where((q) => q.eq("projectId", projectId))
      .order("asc");
  },
});

export const createTask = action({
  name: "createTask",
  args: { id: v.string(), projectId: v.string(), title: v.string() },
  handler: function* ({ id, projectId, title }) {
    yield* insert(tasksTable, [
      { id, projectId, title, state: "todo", orderToken: id },
    ]);
  },
});

syncDispatch(db, createTask({ id: "task-1", projectId: "p1", title: "Ship" }));
```

Selectors can be defined in object form or by wrapping a function. Object-form
selectors support:

- `name`: required display/debug name
- `args`: validator map for the single args object
- `handler`: generator function
- `skipTrace`: `true` or `{ rootTrace, childTrace }`
- `memoization`: `{ root?: boolean, selfChild?: boolean }`

Actions can also be object-form or function-form. Object-form actions support
`name`, `args`, and `handler`. Actions can yield mutations with `insert`,
`upsert`, and `deleteRows`, and may read with `selectFrom`. Selectors cannot
write; the command runner rejects writes unless it is dispatching an action.
`insert` fails for duplicate ids, `upsert` replaces the whole row, and
`deleteRows` ignores ids that do not exist.

Selector cache behavior:

- `initCachedSelector(db, selector, args)` caches by DB, selector identity, and a
  stable serialization of args.
- Equivalent object args with different key order share the same cache entry.
- Subscribed selectors rerun only when a mutation touches a scanned range.
- Unsubscribed cache entries are retained for `gcTime` ms; the default is
  `3000`. Pass `{ gcTime: 0 }` to drop immediately.
- Root memoization is on by default. Use `memoization: { root: false }` to opt
  out. Use `memoization: { selfChild: true }` to memoize a nested selector's own
  child subtree across reruns.

## DB Runtime

Create a DB with a driver, load tables, then run commands through the generator
executor.

```ts
import {
  BptreeInmemDriver,
  DB,
  hyperDBTraceStore,
  SubscribableDB,
} from "@will-be-done/hyperdb-lib";

const baseDb = new DB(new BptreeInmemDriver(), {
  runtimeValidation: true,
  freezeArgs: true,
  freezeRows: false,
  tracer: hyperDBTraceStore,
});

const db = new SubscribableDB(baseDb);

db.loadTables([tasksTable]);
```

Runtime options:

- `runtimeValidation`: validate full records against table validators on writes
  and reads.
- `freezeArgs`: deep-freeze selector args used by cached selectors/runs.
- `freezeRows`: deep-freeze rows after write normalization.
- `traits`: initial metadata traits attached to the DB.
- `tracer`: per-DB tracer implementation used to configure tracing behavior for
  this database instead of using the global default tracer.

Runtime types:

- `DB`: core HyperDB runtime around a storage driver.
- `SubscribableDB`: wraps a DB with subscriptions, revisions, operation
  notifications, and `afterInsert`/`afterUpsert`/`afterDelete`/`afterChange`
  hooks.

## Storage

Storage is provided by drivers:

- `BptreeInmemDriver`: in-memory driver, good for tests and ephemeral local data.
- `SqlDriver`: synchronous SQLite-compatible driver.
- `AsyncSqlDriver`: async SQLite-compatible driver.
- `IdbDriver`: async IndexedDB driver for browser persistence.

```ts
import {
  DB,
  BptreeInmemDriver,
  execAsync,
  initSqlJsWasm,
  openIndexedDBDriver,
} from "@will-be-done/hyperdb-lib";

const memoryDb = new DB(new BptreeInmemDriver());

const sqliteDriver = await initSqlJsWasm();
const sqliteDb = new DB(sqliteDriver);

const idbDriver = await openIndexedDBDriver("my-app-db");
const idbDb = new DB(idbDriver);
await execAsync(idbDb.loadTables([tasksTable]));
```

SQLite helpers currently live next to the drivers:
`src/hyperdb/drivers/sqlite/init-sql-js-wasm.ts` returns a `SqlDriver` backed by
`sql.js`, and `src/hyperdb/drivers/sqlite/init-wa-sqlite.ts` returns an
`AsyncSqlDriver` backed by `wa-sqlite`.

Use `execAsync`/`asyncDispatch` with IndexedDB and async SQLite. The in-memory
driver and synchronous SQLite driver can also be used through `SyncDB`,
`execSync`, and `syncDispatch`.

The storage codec normalizes values before they reach drivers. SQLite encodes
`bigint`, `ArrayBuffer`, and typed-array/data-view values around JSON storage;
the IndexedDB driver uses the same storage encoding and sort-key ordering as the
SQLite driver; the in-memory driver stores normalized JS values directly.

## React And Devtools

The only framework integration today is React, exported from
`@will-be-done/hyperdb-lib/react`.

```tsx
import {
  DBProvider,
  useDispatch,
  useSyncSelector,
} from "@will-be-done/hyperdb-lib/react";
import { HyperDBDevtools } from "@will-be-done/hyperdb-lib/devtool";

function Tasks({ projectId }: { projectId: string }) {
  const tasks = useSyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });
  const dispatch = useDispatch();

  return (
    <>
      <button
        onClick={() =>
          dispatch(
            createTask({
              id: crypto.randomUUID(),
              projectId,
              title: "New task",
            }),
          )
        }
      >
        Add
      </button>
      {tasks.map((task) => (
        <div key={task.id}>{task.title}</div>
      ))}
    </>
  );
}

export function App() {
  return (
    <DBProvider value={db}>
      <Tasks projectId="p1" />
      <HyperDBDevtools db={db} initialIsOpen={false} />
    </DBProvider>
  );
}
```

React exports include `DBProvider`, `useDB`, `useSyncSelector`,
`useAsyncSelector`, `useDispatch`, `useAsyncDispatch`, `useSelect`, and
`useAsyncSelect`. The devtool can read the DB from context or from its `db` prop.
