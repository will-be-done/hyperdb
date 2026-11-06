---
"@will-be-done/hyperdb": minor
---

Add schema annotations: `.with()` on validators and tables, read through `defineAnnotation()`. Undo replays updates field by field, so concurrent edits to other fields no longer conflict. Columns marked `.with(undoIgnore())` are never undone. Add a `skip(traits)` option, `dropUndo()` / `dropRedo()`, and return the replayed event from `undo()` / `redo()`.
