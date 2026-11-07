---
"@will-be-done/hyperdb": patch
---

`SqlDriver` and `AsyncSqlDriver` now share one implementation, so schema reconciliation and write atomicity behave identically. Both run one transaction at a time: while it is open, `SqlDriver` rejects other operations and `AsyncSqlDriver` makes them wait. A failed `BEGIN` no longer leaves `SqlDriver` stuck reporting a transaction in progress, `SqlDriver.loadTables()` is rejected while a transaction is open (as its other operations already were), and `AsyncSqlDriver` only logs a warning when a rollback itself fails.
