---
"@will-be-done/hyperdb": patch
---

Harden failure and shutdown paths:

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
