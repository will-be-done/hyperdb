---
"@will-be-done/hyperdb": patch
---

Fix "Invalid bounds" errors on the in-memory and IndexedDB drivers for composite-index scans that combine an equality prefix with `gt`, or with `gte`/`gt` and `lt` on the next column, such as `q.eq("a", 1).gte("b", "x").lt("b", "z")`. Combining `gt` with `gte`, or `lt` with `lte`, on one column now throws a clear error.
