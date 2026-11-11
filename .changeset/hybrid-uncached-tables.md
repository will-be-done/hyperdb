---
"@will-be-done/hyperdb": minor
---

Add the `uncachedTables` option to `HybridDB`. Rows of these tables never enter the in-memory cache: reads always go to the primary store, while writes still persist with the rest of their transaction, and a transaction reads its own writes until it commits. `preloadTables` rejects uncached tables, and `preloadSelectorAsync` does not prime the cache with selectors that read them.
