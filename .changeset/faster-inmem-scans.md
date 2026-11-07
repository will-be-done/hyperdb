---
"@will-be-done/hyperdb": patch
---

In-memory index scans with a single range now read rows straight from the tree, which makes them about twice as fast. In-memory writes are also cheaper: bulk inserts are 6–19% faster and transaction commits about 10% faster.
