---
"@will-be-done/hyperdb": patch
---

Commands are branded, so an object a handler yields that merely looks like a command (for example `{ type: "insert", ... }`) is rejected with `UNSUPPORTED_COMMAND` instead of being executed. Traces no longer mark a select as failed when the handler throws after the select returned.
