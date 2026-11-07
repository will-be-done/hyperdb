---
"@will-be-done/hyperdb": patch
---

SQLite driver fixes:

- Readonly transactions (`beginTx("readonly")`) reject writes with `READONLY_TRANSACTION`.
- `commit()` and `rollback()` wait for a write that is still running in the same transaction.
- When SQLite has already rolled a transaction back on its own (for example after a full disk), `rollback()` frees the driver instead of failing. If a rollback itself fails, the driver rejects every later operation, since the connection may still be inside the transaction.
- `loadTables()` rejects table names that differ only in case, which SQLite treats as the same table.
- Schema reconciliation rebuilds an index's sort keys when its columns, uniqueness, or sort order change under the same name, and backfills large tables in pages.
- An `AsyncSqlDriver` `debug` callback that throws is logged with `console.error` and no longer fails the statement.
