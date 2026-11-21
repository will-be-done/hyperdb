---
"@will-be-done/hyperdb": minor
---

Add `useSuspenseSelector`, a React hook that returns the selector result and suspends until the first result for its args is ready. Database changes that rerun the selector keep the previous result on screen. Change its args with `startTransition` or `useDeferredValue` to keep the previous view while the next one loads. A failed first read is thrown to the error boundary and read again after the database changes. Works with React 18 and 19.
