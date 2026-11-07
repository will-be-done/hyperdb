---
"@will-be-done/hyperdb": minor
---

**Breaking (types):** selector and action handlers have typed yields. Selector handlers may yield only reads, so `insert`/`upsert`/`deleteRows` or an action inside a selector is now a compile error (the runtime guard is unchanged). `yield value` of a non-command is a type error. Helpers annotated as `Generator<unknown, T>` must switch to the new `SelectorGenerator<T>` (reads) or `ActionGenerator<T>` (may write); inferred helper types keep working. `SelectorCommand` and `ActionCommand` export the yield unions. Lifecycle hooks and `withoutUndo` bodies are typed as `ActionGenerator`.

The package is now built with `strict` TypeScript, and test-only utilities are no longer emitted into `dist`.
