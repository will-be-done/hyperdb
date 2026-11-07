---
"@will-be-done/hyperdb": minor
---

`SqlDriver` and `AsyncSqlDriver` report primary-key collisions as `DuplicateIdError` (with `id`, and the engine error as `cause`) instead of SQLite's raw `UNIQUE constraint failed` error, matching the in-memory and IndexedDB drivers. Unique-index violations still pass through unchanged. `DuplicateIdError` accepts an optional `ErrorOptions` argument.
