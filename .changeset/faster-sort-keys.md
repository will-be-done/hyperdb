---
"@will-be-done/hyperdb": patch
---

The SQLite and IndexedDB drivers encode index sort keys about ten times faster, which speeds up every indexed write and every index scan. The stored key format is unchanged, so existing databases need no migration.
