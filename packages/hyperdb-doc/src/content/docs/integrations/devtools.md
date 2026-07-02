---
title: Devtools & Tracing
description: Inspect selector runs and mutations with the in-app devtool, and configure tracing.
sidebar:
  order: 2
---

HyperDB can record a trace of every selector run and mutation, and ships an
in-app devtool to browse them. Tracing is what powers the devtool, but you can
also configure it independently.

![The HyperDB devtool showing a trace list on the left and the Call Tree of a selector on the right](../../../assets/devtool-call-tree.png)

## The devtool panel

The devtool is exported from `@will-be-done/hyperdb-devtool/react`. Render
`HyperDBDevtools` anywhere in your tree; it can read the database from
[`DBProvider`](/integrations/react/) context, or take an explicit `db` prop.

```tsx
import { DBProvider } from "@will-be-done/hyperdb/react";
import { HyperDBDevtools } from "@will-be-done/hyperdb-devtool/react";
import { db } from "./db";

export function App() {
  return (
    <DBProvider value={db}>
      <YourApp />
      <HyperDBDevtools db={db} initialIsOpen={false} />
    </DBProvider>
  );
}
```

### `HyperDBDevtools` props

| Prop             | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `db`             | The `SubscribableDB` to inspect (defaults to context)       |
| `initialIsOpen`  | Whether the panel starts open (persisted in `localStorage`) |
| `position`       | `"top"` \| `"bottom"` \| `"left"` \| `"right"`              |
| `buttonPosition` | Corner for the toggle button                                |
| `maxTraces`      | Maximum number of traces to retain                          |
| `theme`          | `"dark"` \| `"light"` \| `"system"`                         |

There is also `HyperDBDevtoolsPanel` for embedding the panel directly (without
the floating toggle), with an `embedded` flag and an `onClose` callback.

## Tracing

Each selector and action run produces a root trace containing the nested
selector frames, the index ranges scanned, and the mutations performed. Cache
hits are recorded too, so you can see when a selector was reused instead of
recomputed.

The trace list can be sorted by creation time, duration, or rows fetched. The
rows fetched sort uses the total rows returned by all select events in a trace,
which makes broad scans and high-fanout selectors easier to spot.

Trace rows are tagged with an `in-mem` badge when no select fell through to a
persistent scan — every read was served from the `HybridDB` memory cache.
Mutations do not affect the badge: writes commit to the in-memory cache within
the trace and are flushed to the persistent database separately, so an action
that only wrote through the cache still counts as in-mem. This makes it easy to
spot which traces avoided reading from persistent storage.

The details pane keeps the active tab while you move between traces, so you can
compare Overview, Queries, Mutations, or Call Tree output without reselecting
the same tab each time.

When a selector reads through `HybridDB`, select nodes in the call tree also show
where the returned rows came from: `in-mem` for the memory cache, or `persist`
for the primary persistent database.

### Per-DB tracer

Set a tracer when constructing a [`DB`](/runtime/db/). Pass the shared store, the
string `"default"`, or `"disabled"`.

```ts
import { DB, hyperDBTraceStore } from "@will-be-done/hyperdb";

const db = new DB(driver, { tracer: hyperDBTraceStore });
```

### Global default tracer

To enable tracing for all databases that don't specify their own, set the global
default:

```ts
import {
  setDefaultHyperDBTracer,
  hyperDBTraceStore,
} from "@will-be-done/hyperdb/tracing";

setDefaultHyperDBTracer(hyperDBTraceStore);
```

### Trace options

Selector and action factories accept a `trace` option (`{ enabled, startOn }`):

```ts
import { createSelector } from "@will-be-done/hyperdb";

const selector = createSelector({
  trace: { enabled: true, startOn: "devtoolOpen" },
});
```

| Field     | Values                                | Meaning                                    |
| --------- | ------------------------------------- | ------------------------------------------ |
| `enabled` | `boolean` (default `true`)            | Whether this factory's commands are traced |
| `startOn` | `"devtoolOpen"` (default) \| `"load"` | When to begin collecting traces            |

`startOn: "devtoolOpen"` keeps overhead near zero until you actually open the
devtool; `"load"` traces from startup.

### Skipping traces per command

Individual selectors and actions can opt out with `skipTrace`:

```ts
selector({
  name: "hotPathSelector",
  args: {},
  skipTrace: true, // or { rootTrace: boolean, childTrace: boolean }
  handler: function* () {
    /* ... */
  },
});
```

Use `skipTrace` on extremely hot paths where even tracing metadata is measurable,
or to keep noisy internal selectors out of the devtool.
