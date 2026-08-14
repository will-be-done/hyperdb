---
"@will-be-done/hyperdb": patch
---

Speed up repeated SQLite `loadTables()` calls with persisted schema signatures
and make SQLite schema reconciliation handle identifiers case-insensitively.
Ensure rejected async driver commands run generator cleanup, including
transaction rollback and lock release.
