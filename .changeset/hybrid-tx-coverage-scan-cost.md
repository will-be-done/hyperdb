---
"@will-be-done/hyperdb": patch
---

Fix HybridDB write transactions slowing down quadratically as they read and write more rows. Each scan subtracted every coverage interval from every target interval and rescanned all pending writes; large transactions such as an initial sync now stay linear.
