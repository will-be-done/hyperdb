---
title: React
description: Provide a database through context and read/write it with HyperDB's React hooks.
sidebar:
  order: 1
---

The React integration lives at `@will-be-done/hyperdb/react`. It provides a
context provider plus hooks for reactive reads, dispatching actions, and one-off
reads. React 18 is a peer dependency.

HyperDB hands your components plain, immutable rows: frozen
data, never proxies. There is no `observer()` wrapper to remember and
nothing leaking into your view layer. The selector hooks use HyperDB's
[range-tracked reads](/database/selectors-reactivity/), so a component re-runs
only when a mutation touches a range its selector actually scanned, giving
fine-grained updates that compose with React's rendering model directly.

## Providing the database

Wrap your tree in `DBProvider` and pass a [`SubscribableDB`](/runtime/db/) as its
value. Every hook reads the database from this context.

```tsx
import { DBProvider } from "@will-be-done/hyperdb/react";
import { db } from "./db";

export function App() {
  return (
    <DBProvider value={db}>
      <Tasks projectId="p1" />
    </DBProvider>
  );
}
```

`useDB()` returns the database from context (and throws if there's no provider).
It is useful for passing the DB to non-hook utilities.

## Reactive reads

### `useAsyncSelector`

Use `useAsyncSelector` with `HybridDB`, IndexedDB, and async SQLite. This is the
usual hook for local-first browser apps: the last resolved result can stay
visible while HybridDB loads missing index ranges from the primary store.

```tsx
import { useAsyncSelector } from "@will-be-done/hyperdb/react";
import { projectTasks } from "./tasks";

function Tasks({ projectId }: { projectId: string }) {
  const {
    data: tasks = [],
    error,
    isFetching,
    isLoading,
    isError,
    refetch,
  } = useAsyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });

  if (isError) return <p>{String(error)}</p>;

  const showSpinner = isLoading || isFetching;

  return (
    <>
      {showSpinner ? <span>Loading...</span> : null}
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>{task.title}</li>
        ))}
      </ul>
      <button onClick={() => void refetch()}>Refresh</button>
    </>
  );
}
```

The hook accepts the selector and args to run, then returns a query-style result
object with `data`, `status`, `error`, fetching flags, and `refetch()`. Each run
starts against the current cache. If a selector needs IndexedDB, async SQLite, or
a HybridDB primary-store fallback, the run continues asynchronously. The initial
snapshot attempts the selector once: if it finishes synchronously, that value is
visible immediately; if it returns a promise, the hook shows `defaultValue`,
`initialData`, or `placeholderData` until the same promise resolves. It does not
read a cached selector snapshot during render.

Options:

| Option                 | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `selector`             | The selector to run                                                        |
| `args`                 | Its arguments (also the reactive identity)                                 |
| `enabled`              | Set `false` to skip automatic runs; call `refetch()` to run manually       |
| `defaultValue`         | Compatibility alias for placeholder data before the first resolved run     |
| `initialData`          | Initial successful data for the result                                     |
| `initialDataUpdatedAt` | Timestamp for `initialData`                                                |
| `placeholderData`      | Temporary data while the selector is still pending                         |
| `subscribed`           | Set `false` to avoid automatic runs and DB subscriptions for this instance |
| `throwOnError`         | Throw render-phase errors to an error boundary when `true` or a predicate  |

Returns:

| Field                                                 | Description                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `data`                                                | Last successful selector result, placeholder data, initial data, or `undefined` |
| `status`                                              | `"pending"`, `"success"`, or `"error"`                                          |
| `fetchStatus`                                         | `"fetching"` or `"idle"` (`"paused"` is reserved for query compatibility)       |
| `error`                                               | Last selector error, or `null`                                                  |
| `dataUpdatedAt` / `errorUpdatedAt`                    | Timestamps for the last success or error                                        |
| `isPending` / `isSuccess` / `isError`                 | Status booleans                                                                 |
| `isFetching` / `isLoading` / `isRefetching`           | Fetching booleans                                                               |
| `isLoadingError` / `isRefetchError`                   | Distinguish first-load failures from refresh failures                           |
| `isPlaceholderData` / `isStale` / `isEnabled`         | Extra query-state booleans                                                      |
| `failureCount` / `failureReason` / `errorUpdateCount` | Failure counters and reason                                                     |
| `promise`                                             | Promise for the current run's data                                              |
| `refetch(options)`                                    | Manually rerun the selector; pass `{ throwOnError: true }` to reject on error   |

For route loaders or intent prefetches, use `preloadSelectorAsync` with the same
`SubscribableDB`, selector, and args the component will render. With HybridDB it
loads missing primary-store ranges and primes the selector cache that
`useAsyncSelector` can reuse when its async run starts.

```ts
import {
  preloadSelectorAsync,
  type SubscribableDB,
} from "@will-be-done/hyperdb";
import { projectTasks } from "./tasks";

export async function preloadProjectRoute(
  db: SubscribableDB,
  projectId: string,
) {
  await preloadSelectorAsync(db, {
    selector: projectTasks,
    args: { projectId },
  });
}
```

### `useSyncSelector`

Use `useSyncSelector` with synchronous drivers: in-memory or sync SQLite. It is
the simplest path when your app can load its whole working state into memory, so
there are no promise or cache-miss tradeoffs.

```tsx
import { useSyncSelector } from "@will-be-done/hyperdb/react";
import { projectTasks } from "./tasks";

function Tasks({ projectId }: { projectId: string }) {
  const tasks = useSyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });

  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}
```

Options:

| Option         | Description                                            |
| -------------- | ------------------------------------------------------ |
| `selector`     | The selector to run                                    |
| `args`         | Its arguments (also the cache key)                     |
| `defaultValue` | Value returned before the first result / when disabled |
| `enabled`      | Set `false` to skip running; returns `defaultValue`    |

## Writing

### `useDispatch` / `useAsyncDispatch`

Return a function that dispatches an action against the context database.

```tsx
import { useAsyncDispatch } from "@will-be-done/hyperdb/react";
import { createTask } from "./tasks";

function AddButton({ projectId }: { projectId: string }) {
  const dispatch = useAsyncDispatch();
  return (
    <button
      onClick={() =>
        void dispatch(
          createTask({ id: crypto.randomUUID(), projectId, title: "New" }),
        )
      }
    >
      Add
    </button>
  );
}
```

Use `useAsyncDispatch` with `HybridDB`, IndexedDB, and async SQLite. Use
`useDispatch` only with synchronous drivers. With HybridDB, writes update the
in-memory cache first so subscribed UI can respond immediately, then flush to
the primary store in order.

## One-off reads

`useSelectSync` and `useSelectAsync` return a function for imperative, non-reactive
reads, for example reading inside an event handler. They don't subscribe.

```tsx
import { useSelectAsync } from "@will-be-done/hyperdb/react";

const select = useSelectAsync();
const handleClick = async () => {
  const tasks = await select({
    selector: projectTasks,
    args: { projectId: "p1" },
  });
};
```

Use `useSelectSync` for synchronous drivers.

## Hook reference

| Hook                     | Returns                                    | Use with                            |
| ------------------------ | ------------------------------------------ | ----------------------------------- |
| `useDB()`                | the `SubscribableDB`                       | accessing the DB directly           |
| `useAsyncSelector(opts)` | query-style result object                  | `HybridDB`, IndexedDB, async SQLite |
| `useSyncSelector(opts)`  | the selector result                        | in-memory and sync SQLite           |
| `useAsyncDispatch()`     | `(action) => Promise<TReturn>`             | `HybridDB`, IndexedDB, async SQLite |
| `useDispatch()`          | `(action) => TReturn`                      | in-memory and sync SQLite           |
| `useSelectAsync()`       | `({ selector, args }) => Promise<TReturn>` | one-off read, async runtimes        |
| `useSelectSync()`        | `({ selector, args }) => TReturn`          | one-off read, sync runtimes         |
