---
"@will-be-done/hyperdb": patch
---

`SqlDriver` and `AsyncSqlDriver` now share one implementation, so schema reconciliation, write atomicity, and transaction handling behave identically. A failed `BEGIN` no longer leaves `SqlDriver` stuck reporting a transaction in progress, `SqlDriver.loadTables()` is rejected while a transaction is open (as its other operations already were), and `AsyncSqlDriver` only logs a warning when a rollback itself fails.
