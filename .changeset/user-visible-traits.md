---
"@will-be-done/hyperdb": minor
---

**Breaking:** `getCurrentTraits()`, mutation hooks (`afterInsert` / `afterUpsert` / `afterDelete` / `afterChange`), and `subscribe` callbacks no longer include HyperDB's internal tracing traits (`hyperdb.traceContext`, `hyperdb.driverTraceContext`, `hyperdb.currentSelectEvent`). Code that read the trace through `getTraceContextFromTraits(traits)` should call `getTraceContextForDB(db)` on the DB a hook receives. `afterScan` callbacks are typed as `ActionGenerator`.
