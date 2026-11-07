---
"@will-be-done/hyperdb": minor
---

Add a `HyperDBError` base class with stable `code`s and `isHyperDBError(error, code)`. Duplicate ids throw `DuplicateIdError` (with `id`), validation failures throw `ValidationError`, and `HybridDBCrashedError` / `UndoConflictError` now extend `HyperDBError`. Error messages are unchanged.

Add `close()` to `DB`, `SubscribableDB`, `HybridDB`, and `PreloadedHybridDB`. It flushes hybrid persistence, releases driver-owned resources (drivers may implement an optional synchronous `close()`), clears subscribers, and unregisters the DB from devtools. Later operations throw `DB_CLOSED`.

Add `dispatchMaybeAsync`, which returns the action result synchronously when no step had to wait.

The command runner no longer calls `console.error` for errors it rethrows; previously a failure inside nested selectors was logged once per nesting level.
