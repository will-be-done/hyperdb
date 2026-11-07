---
"@will-be-done/hyperdb": minor
---

Validators now have separate input and output types. `v.arrayBuffer()` accepts `ArrayBuffer | ArrayBufferView` and produces `ArrayBuffer`, so `insert`/`upsert` take typed arrays and `DataView`s without a cast. New helpers: `InferInput`, `InferObjectInput`, `InferTableSchemaInput`, and `ExtractSchemaInput<typeof table>` (the row type writes accept); `Infer` and `ExtractSchema` are unchanged and describe what reads return. Binary columns are now converted to an `ArrayBuffer` on every write, even with runtime row validation off (including inside lazy validators and union members), so reads, mutation hooks, and `subscribe` callbacks always see an `ArrayBuffer`. Type-level note: a validator annotated by hand as `Validator<ArrayBuffer>` (or a composite containing one) needs its input type, e.g. `Validator<ArrayBuffer, ArrayBuffer | ArrayBufferView>`.
