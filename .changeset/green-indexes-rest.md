---
"@will-be-done/hyperdb": minor
---

Add `PreloadedHybridDB`, which preloads every declared index with ID-only leaves
and batch-hydrates missing entity rows through the built-in `byId` `uniqhash`.
Secondary `uniqhash` indexes are preloaded as value-to-ID pointers, while shared
hash-index transactions provide copy-on-write commit and rollback behavior.
Add `externalStorageMergeTrait` for changesets already persisted by another
runtime sharing the primary. Their normal merge operations update the preloaded
snapshot, notify subscribers, and persist external inserts idempotently.
