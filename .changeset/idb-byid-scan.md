---
"@will-be-done/hyperdb": patch
---

The IndexedDB driver rejects range and full scans on a hash `id` index such as `byId`, like the other drivers do, instead of silently returning no rows. Use a B-tree index over `id` (for example `byIds`) for full scans.
