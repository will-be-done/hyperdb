---
"@will-be-done/hyperdb": patch
---

Selector preloading finds a hybrid runtime's in-memory cache through a new optional `HyperDB.getCacheDB()` method instead of probing private fields, so it keeps working when runtimes are wrapped.
