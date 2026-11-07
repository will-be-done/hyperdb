---
"@will-be-done/hyperdb": patch
---

Selector invalidation skips ops on tables a selector never read. Each commit groups its ops by table once and every subscriber reuses the grouping.
