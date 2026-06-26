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
nothing leaking into your view layer. The hooks subscribe through HyperDB's
[range-tracked selector cache](/database/selectors-reactivity/), so a component
re-renders only when a mutation touches a range its selector actually scanned,
giving fine-grained updates that compose with React's rendering model directly.

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

### `useSyncSelector`

For synchronous drivers (in-memory, sync SQLite). It subscribes to a cached
selector and re-renders only when the selector's scanned ranges change.

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
      {tasks.map((t) => (
        <li key={t.id}>{t.title}</li>
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

### `useAsyncSelector`

For asynchronous drivers (IndexedDB, async SQLite). It accepts the same
`selector` and `args` identity as `useSyncSelector`, but returns a
React Query-style result object so loading, error, and manual refetch states are
explicit.

Each run starts synchronously. If the selector completes from memory or cache,
the result is applied in the same tick; if a command yields a promise, that run
continues asynchronously.

```tsx
const {
  data: tasks = [],
  error,
  isFetching,
  isLoading,
  isError,
  refetch,
  status,
} = useAsyncSelector({
  selector: projectTasks,
  args: { projectId },
  defaultValue: [],
});
```

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
| `isFetching` / `isLoading` / `isRefetching`           | Fetching booleans, matching React Query naming                                  |
| `isLoadingError` / `isRefetchError`                   | Distinguish first-load failures from refresh failures                           |
| `isPlaceholderData` / `isStale` / `isEnabled`         | Extra query-state booleans                                                      |
| `failureCount` / `failureReason` / `errorUpdateCount` | Failure counters and reason                                                     |
| `promise`                                             | Promise for the current run's data                                              |
| `refetch(options)`                                    | Manually rerun the selector; pass `{ throwOnError: true }` to reject on error   |

## Writing

### `useDispatch` / `useAsyncDispatch`

Return a function that dispatches an action against the context database.

```tsx
import { useDispatch } from "@will-be-done/hyperdb/react";
import { createTask } from "./tasks";

function AddButton({ projectId }: { projectId: string }) {
  const dispatch = useDispatch();
  return (
    <button
      onClick={() =>
        dispatch(
          createTask({ id: crypto.randomUUID(), projectId, title: "New" }),
        )
      }
    >
      Add
    </button>
  );
}
```

`useAsyncDispatch` returns a function that yields a `Promise`; use it with async
drivers.

## One-off reads

`useSelect` and `useAsyncSelect` return a function for imperative, non-reactive
reads, for example reading inside an event handler. They don't subscribe.

```tsx
import { useSelect } from "@will-be-done/hyperdb/react";

const select = useSelect();
const handleClick = () => {
  const tasks = select(projectTasks({ projectId: "p1" }));
};
```

## Hook reference

| Hook                     | Returns                        | For                          |
| ------------------------ | ------------------------------ | ---------------------------- |
| `useDB()`                | the `SubscribableDB`           | accessing the DB directly    |
| `useSyncSelector(opts)`  | the selector result            | reactive read, sync drivers  |
| `useAsyncSelector(opts)` | React Query-style result       | reactive read, async drivers |
| `useDispatch()`          | `(action) => TReturn`          | write, sync drivers          |
| `useAsyncDispatch()`     | `(action) => Promise<TReturn>` | write, async drivers         |
| `useSelect()`            | `(gen) => TReturn`             | one-off read, sync drivers   |
| `useAsyncSelect()`       | `(gen) => Promise<TReturn>`    | one-off read, async drivers  |
