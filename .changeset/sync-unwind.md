---
"@will-be-done/hyperdb": patch
---

`execSync` now throws its `ASYNC_IN_SYNC_EXECUTION` error into the running generator, so `finally` blocks such as transaction rollback run before the error reaches the caller. `syncDispatch` shares the async dispatch path as a result.
