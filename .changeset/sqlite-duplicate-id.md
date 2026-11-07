---
"@will-be-done/hyperdb": minor
---

`SqlDriver` and `AsyncSqlDriver` report primary-key collisions as `DuplicateIdError` (with `id`, and the engine error as `cause`) instead of SQLite's raw `UNIQUE constraint failed` error, matching the in-memory and IndexedDB drivers. A row that repeats an id is reported as `DuplicateIdError` even if it also breaks a `uniqhash` index. Other unique-index violations still pass through unchanged. `DuplicateIdError` accepts an optional `ErrorOptions` argument.
