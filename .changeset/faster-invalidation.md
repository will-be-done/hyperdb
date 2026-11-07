---
"@will-be-done/hyperdb": patch
---

Selector invalidation skips ops on tables a selector never read. Each commit groups its ops by table once and every subscriber reuses the grouping, along with each changed row's index tuple. A cached selector pads its range bounds once instead of on every commit, which makes a commit that no cached selector reads about nine times cheaper to check.
