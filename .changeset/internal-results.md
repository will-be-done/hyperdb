---
"@will-be-done/hyperdb": patch
---

Internal: SQLite schema-metadata checks use typed results, and both SQLite drivers share one metadata matcher. `neverthrow` is now a runtime dependency; it is not part of the public API or types.
