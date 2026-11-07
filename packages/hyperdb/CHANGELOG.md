# @will-be-done/hyperdb

## 0.10.0

### Minor Changes

- ed8de5c: Add a `HyperDBError` base class with stable `code`s and `isHyperDBError(error, code)`. Duplicate ids throw `DuplicateIdError` (with `id`), validation failures throw `ValidationError`, and `HybridDBCrashedError` / `UndoConflictError` now extend `HyperDBError`. Error messages are unchanged.

  Add `close()` to `DB`, `SubscribableDB`, `HybridDB`, and `PreloadedHybridDB`. It flushes hybrid persistence, releases driver-owned resources (drivers may implement an optional synchronous `close()`), clears subscribers, and unregisters the DB from devtools. Later operations throw `DB_CLOSED`.

  Add `dispatchMaybeAsync`, which returns the action result synchronously when no step had to wait.

  The command runner no longer calls `console.error` for errors it rethrows; previously a failure inside nested selectors was logged once per nesting level.

- 1bb3535: **Breaking (behavior):** when a read or write fails, its error is now raised at the handler's `yield*` instead of abandoning the handler, so `try` / `catch` / `finally` inside actions and selectors see it. Uncaught errors still roll the transaction back. To make catching safe, multi-statement SQLite writes (upserts and chunked inserts/deletes) inside a transaction run in a savepoint, so a failed write has no partial effect. A child selector's scanned ranges stay subscribed when its parent catches the child's error. `PreloadedHybridDB` duplicate inserts now throw `DuplicateIdError`. The IndexedDB driver no longer reports an aborted transaction as an unhandled rejection.
- 2b80a2a: `SqlDriver` and `AsyncSqlDriver` report primary-key collisions as `DuplicateIdError` (with `id`, and the engine error as `cause`) instead of SQLite's raw `UNIQUE constraint failed` error, matching the in-memory and IndexedDB drivers. A row that repeats an id is reported as `DuplicateIdError` even if it also breaks a `uniqhash` index. Other unique-index violations still pass through unchanged. `DuplicateIdError` accepts an optional `ErrorOptions` argument.
- 3c3b146: **Breaking (types):** selector and action handlers have typed yields. Selector handlers may yield only reads, so `insert`/`upsert`/`deleteRows` or an action inside a selector is now a compile error (the runtime guard is unchanged). `yield value` of a non-command is a type error. Helpers annotated as `Generator<unknown, T>` must switch to the new `SelectorGenerator<T>` (reads) or `ActionGenerator<T>` (may write); inferred helper types keep working. `SelectorCommand` and `ActionCommand` export the yield unions. Lifecycle hooks and `withoutUndo` bodies are typed as `ActionGenerator`.

  The package is now built with `strict` TypeScript, and test-only utilities are no longer emitted into `dist`.

- 14ac4be: **Breaking:** `getCurrentTraits()`, mutation hooks (`afterInsert` / `afterUpsert` / `afterDelete` / `afterChange`), and `subscribe` callbacks no longer include HyperDB's internal tracing traits (`hyperdb.traceContext`, `hyperdb.driverTraceContext`, `hyperdb.currentSelectEvent`). Code that read the trace through `getTraceContextFromTraits(traits)` should call `getTraceContextForDB(db)` on the DB a hook receives. `afterScan` callbacks are typed as `ActionGenerator`.
- 39fe6ef: Validators now have separate input and output types. `v.arrayBuffer()` accepts `ArrayBuffer | ArrayBufferView` and produces `ArrayBuffer`, so `insert`/`upsert` take typed arrays and `DataView`s without a cast. New helpers: `InferInput`, `InferObjectInput`, `InferTableSchemaInput`, and `ExtractSchemaInput<typeof table>` (the row type writes accept); `Infer` and `ExtractSchema` are unchanged and describe what reads return. Binary columns are now converted to an `ArrayBuffer` on every write, even with runtime row validation off (including inside lazy validators and union members), so reads, mutation hooks, and `subscribe` callbacks always see an `ArrayBuffer`. Type-level note: a validator annotated by hand as `Validator<ArrayBuffer>` (or a composite containing one) needs its input type, e.g. `Validator<ArrayBuffer, ArrayBuffer | ArrayBufferView>`.

### Patch Changes

- f8a7869: Commands are branded, so an object a handler yields that merely looks like a command (for example `{ type: "insert", ... }`) is rejected with `UNSUPPORTED_COMMAND` instead of being executed. Traces no longer mark a select as failed when the handler throws after the select returned.
- 14292f3: Selector preloading finds a hybrid runtime's in-memory cache through a new optional `HyperDB.getCacheDB()` method instead of probing private fields, so it keeps working when runtimes are wrapped.
- 7df9c0a: In-memory index scans with a single range now read rows straight from the tree, which makes them about twice as fast. In-memory writes are also cheaper: bulk inserts are 6–19% faster and transaction commits about 10% faster.
- 8b9e77d: Selector invalidation skips ops on tables a selector never read. Each commit groups its ops by table once and every subscriber reuses the grouping, along with each changed row's index tuple. A cached selector pads its range bounds once instead of on every commit, which makes a commit that no cached selector reads about nine times cheaper to check.
- 0f3a95a: The SQLite and IndexedDB drivers encode index sort keys about ten times faster, which speeds up every indexed write and every index scan. The stored key format is unchanged, so existing databases need no migration.
- 4f587f3: The IndexedDB driver rejects range and full scans on a hash `id` index such as `byId`, like the other drivers do, instead of silently returning no rows. Use a B-tree index over `id` (for example `byIds`) for full scans.
- 65de217: Internal: SQLite schema-metadata checks use typed results, and both SQLite drivers share one metadata matcher. `neverthrow` is now a runtime dependency; it is not part of the public API or types.
- ecd16b5: Harden failure and shutdown paths:

  - A failing mutation hook blocks the commit even if the handler catches its error, and selectors cannot write when an action runs them.
  - Hybrid runtimes refuse new commits as soon as `close()` starts and wait for accepted ones, so no accepted write is lost. `close()` can be retried after a driver failure, cached selector reads after close throw `DB_CLOSED`, and `PreloadedHybridDB` releases its preloaded data.
  - SQLite transactions refuse to commit if a write's savepoint cannot be released or rolled back. A failed driver commit no longer turns the follow-up rollback into `TRANSACTION_FINISHED`.
  - IndexedDB reports duplicate ids as `DuplicateIdError`, keeps `INDEX_NOT_FOUND`, and accepts matching inclusive bounds on `byId`.
  - `withTraits()` accepts interface-typed traits, `withoutUndo()` rejects generators that do not yield HyperDB commands, and `isHyperDBError` requires a true brand.
  - Selector caching: a child selector's result is not reused after its rerun fails, a Promise returned by a selector is kept as the sync cached value, stale preloads do not prime the cache, caches from another HyperDB copy are reused, and op invalidation matches tables by name.
  - Sync execution aborts before a driver can swallow async-storage errors and preserves `ASYNC_IN_SYNC_EXECUTION` when handlers replace them, while async actions can recover from independent sync failures.
  - Hybrid shutdown waits for in-flight direct writes and continues after its caller abandons the command. A failed `SubscribableDB.close()` refuses new operations while permitting cleanup retries.
  - Subscriber operation arrays are typed readonly, operation objects are frozen, and selector invalidation only reuses prepared operations with immutable payloads.
  - SQLite inserts roll back the entire batch after a trigger failure, including inserts that fit in one statement.

- d57483a: `SqlDriver` and `AsyncSqlDriver` now share one implementation, so schema reconciliation and write atomicity behave identically. Both run one transaction at a time: while it is open, `SqlDriver` rejects other operations and `AsyncSqlDriver` makes them wait. A failed `BEGIN` no longer leaves `SqlDriver` stuck reporting a transaction in progress, `SqlDriver.loadTables()` is rejected while a transaction is open (as its other operations already were), and `AsyncSqlDriver` only logs a warning when a rollback itself fails.
- e6e2e49: SQLite driver fixes:

  - Readonly transactions (`beginTx("readonly")`) reject writes with `READONLY_TRANSACTION`.
  - `commit()` and `rollback()` wait for a write that is still running in the same transaction.
  - When SQLite has already rolled a transaction back on its own (for example after a full disk), `rollback()` frees the driver instead of failing. If a rollback itself fails, the driver rejects every later operation, since the connection may still be inside the transaction.
  - `loadTables()` rejects table names that differ only in case, which SQLite treats as the same table.
  - Schema reconciliation rebuilds an index's sort keys when its columns, uniqueness, or sort order change under the same name, and backfills large tables in pages.
  - An `AsyncSqlDriver` `debug` callback that throws is logged with `console.error` and no longer fails the statement.

- 12754ed: `execSync` now throws its `ASYNC_IN_SYNC_EXECUTION` error into the running generator, so `finally` blocks such as transaction rollback run before the error reaches the caller. `syncDispatch` shares the async dispatch path as a result.
- 5a91f9d: Fix two typing gaps that broke documented usage under `strict`: traits may carry free-form fields next to `type` (`db.withTraits({ type: "import", value: "csv" })` no longer fails excess-property checks), and `history.withoutUndo((scopedDb) => ...)` now types `scopedDb` as `HyperDB` instead of reporting an implicit `any`.

## 0.9.0

### Minor Changes

- 3f38453: Add schema annotations: `.with()` on validators and tables, read through `defineAnnotation()`. Undo replays updates field by field, so concurrent edits to other fields no longer conflict. Columns marked `.with(undoIgnore())` are never undone. Add a `skip(traits)` option, `dropUndo()` / `dropRedo()`, and return the replayed event from `undo()` / `redo()`.

## 0.8.0

### Minor Changes

- f72c65d: Publish cached actions and preloaded transactions in memory before background persistence. Add `waitForPersistence()` so callers can wait for durable storage before broadcasting changes or acknowledging sync.
- cdcc610: Add the optional `@will-be-done/hyperdb/undo` entry point with transaction-based
  undo/redo, per-manager and global scoped exclusions, synchronous grouping,
  history subscriptions, and atomic replay with row conflict detection.

## 0.7.0

### Minor Changes

- Preloaded tables now load concurrently by default, with a generic
  `preloadConcurrency` option accepting a positive bound or `"whole"`.

## 0.6.0

### Minor Changes

- 266b765: Add `PreloadedHybridDB`, which preloads every declared index with ID-only leaves
  and batch-hydrates missing entity rows through the built-in `byId` `uniqhash`.
  Secondary `uniqhash` indexes are preloaded as value-to-ID pointers, while shared
  hash-index transactions provide copy-on-write commit and rollback behavior.
  Add `externalStorageMergeTrait` for changesets already persisted by another
  runtime sharing the primary. Their normal merge operations update the preloaded
  snapshot, notify subscribers, and persist external inserts idempotently.

## 0.5.1

### Patch Changes

- 2287298: Speed up repeated SQLite `loadTables()` calls with persisted schema signatures
  and make SQLite schema reconciliation handle identifiers case-insensitively.
  Ensure rejected async driver commands run generator cleanup, including
  transaction rollback and lock release.

## 0.5.0

### Minor Changes

- cdb4b1f: Allow `AsyncSqlDriver` operations to continue after the database rejects the
  start of a transaction.

## 0.4.4

### Patch Changes

- a003875: Improve work with indexes

## 0.4.3

### Patch Changes

- 53a6916: catch firefox idb tx finish
- 0678e07: add long redonly tx

## 0.4.2

### Patch Changes

- b39fb14: remove console.log logging

## 0.4.1

### Patch Changes

- dbe309d: fix hook strict mode race condition

## 0.4.0

### Minor Changes

- ef8ff80: improve hook
- 7a6c691: Rename the React synchronous dispatch hook from `useDispatch` to `useSyncDispatch`.

## 0.3.0

### Minor Changes

- eab2183: Added uniqhash, delayed persist. Added "in-mem" label to devtool traces

## 0.2.0

### Minor Changes

- efb7ce0: Add hybriddb + better selector + preloader

## 0.1.0

### Minor Changes

- cb0c89d: add HybridDB runtime. Improve react hooks

## 0.0.4

### Patch Changes

- 609ca09: bump version

## 0.0.3

### Patch Changes

- dbc1b5d: version bump check

## 0.0.2

### Patch Changes

- a40fe17: verion bump for check

## 0.0.1

### Patch Changes

- 19096b0: Prepare HyperDB for npm publishing with built package entrypoints.
- 216ccbd: Move the React devtool into a standalone package and remove the goober dependency from HyperDB core.
