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
