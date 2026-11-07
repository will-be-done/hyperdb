---
"@will-be-done/hyperdb": patch
---

Fix two typing gaps that broke documented usage under `strict`: traits may carry free-form fields next to `type` (`db.withTraits({ type: "import", value: "csv" })` no longer fails excess-property checks), and `history.withoutUndo((scopedDb) => ...)` now types `scopedDb` as `HyperDB` instead of reporting an implicit `any`.
