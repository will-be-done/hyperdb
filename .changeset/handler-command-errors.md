---
"@will-be-done/hyperdb": minor
---

**Breaking (behavior):** when a read or write fails, its error is now raised at the handler's `yield*` instead of abandoning the handler, so `try` / `catch` / `finally` inside actions and selectors see it. Uncaught errors still roll the transaction back. To make catching safe, multi-statement SQLite writes (upserts and chunked inserts/deletes) inside a transaction run in a savepoint, so a failed write has no partial effect. A child selector's scanned ranges stay subscribed when its parent catches the child's error. `PreloadedHybridDB` duplicate inserts now throw `DuplicateIdError`. The IndexedDB driver no longer reports an aborted transaction as an unhandled rejection.
