---
"@will-be-done/hyperdb": minor
---

Add `useSuspenseSelector`, a React hook that returns the selector result and suspends until the first result for its args is ready. Database changes that rerun the selector keep the previous result on screen. Change its args with `startTransition` or `useDeferredValue` to keep the previous view while the next one loads. Uses React's `use` on React 19 and throws the promise on React 18.
