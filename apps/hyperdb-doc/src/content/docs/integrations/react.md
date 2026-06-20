---
title: React
description: Provide a database through context and read/write it with HyperDB's React hooks.
sidebar:
  order: 1
---

The React integration lives at `@will-be-done/hyperdb-lib/react`. It provides a
context provider plus hooks for reactive reads, dispatching actions, and one-off
reads. React 19 is a peer dependency.

## Providing the database

Wrap your tree in `DBProvider` and pass a [`SubscribableDB`](/runtime/db/) as its
value. Every hook reads the database from this context.

```tsx
import { DBProvider } from "@will-be-done/hyperdb-lib/react";
import { db } from "./db";

export function App() {
  return (
    <DBProvider value={db}>
      <Tasks projectId="p1" />
    </DBProvider>
  );
}
```

`useDB()` returns the database from context (and throws if there's no provider) —
useful for passing the DB to non-hook utilities.

## Reactive reads

### `useSyncSelector`

For synchronous drivers (in-memory, sync SQLite). It subscribes to a cached
selector and re-renders only when the selector's scanned ranges change.

```tsx
import { useSyncSelector } from "@will-be-done/hyperdb-lib/react";
import { projectTasks } from "./tasks";

function Tasks({ projectId }: { projectId: string }) {
  const tasks = useSyncSelector({
    selector: projectTasks,
    args: { projectId },
    defaultValue: [],
  });
  return <ul>{tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

Options:

| Option | Description |
| --- | --- |
| `selector` | The selector to run |
| `args` | Its arguments (also the cache key) |
| `defaultValue` | Value returned before the first result / when disabled |
| `enabled` | Set `false` to skip running; returns `defaultValue` |
| `gcTime` | Override the cache [garbage-collection time](/database/selectors-reactivity/#garbage-collection) |

### `useAsyncSelector`

For asynchronous drivers (IndexedDB, async SQLite). Same shape, but the result
arrives asynchronously, so it returns `defaultValue` (or `undefined`) until the
first run resolves, and re-runs on relevant changes.

```tsx
const tasks = useAsyncSelector({
  selector: projectTasks,
  args: { projectId },
  defaultValue: [],
});
```

## Writing

### `useDispatch` / `useAsyncDispatch`

Return a function that dispatches an action against the context database.

```tsx
import { useDispatch } from "@will-be-done/hyperdb-lib/react";
import { createTask } from "./tasks";

function AddButton({ projectId }: { projectId: string }) {
  const dispatch = useDispatch();
  return (
    <button
      onClick={() =>
        dispatch(createTask({ id: crypto.randomUUID(), projectId, title: "New" }))
      }
    >
      Add
    </button>
  );
}
```

`useAsyncDispatch` returns a function that yields a `Promise` — use it with async
drivers.

## One-off reads

`useSelect` and `useAsyncSelect` return a function for imperative, **non-reactive**
reads — for example reading inside an event handler. They don't subscribe.

```tsx
import { useSelect } from "@will-be-done/hyperdb-lib/react";

const select = useSelect();
const handleClick = () => {
  const tasks = select(projectTasks({ projectId: "p1" }));
};
```

## Hook reference

| Hook | Returns | For |
| --- | --- | --- |
| `useDB()` | the `SubscribableDB` | accessing the DB directly |
| `useSyncSelector(opts)` | the selector result | reactive read, sync drivers |
| `useAsyncSelector(opts)` | the result or default | reactive read, async drivers |
| `useDispatch()` | `(action) => TReturn` | write, sync drivers |
| `useAsyncDispatch()` | `(action) => Promise<TReturn>` | write, async drivers |
| `useSelect()` | `(gen) => TReturn` | one-off read, sync drivers |
| `useAsyncSelect()` | `(gen) => Promise<TReturn>` | one-off read, async drivers |
