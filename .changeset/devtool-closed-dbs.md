---
"@will-be-done/hyperdb-devtool": patch
---

The database picker drops a DB after `close()` unregisters it, unless the trace list still holds traces from it. Previously a closed DB stayed listed until the page reloaded.
