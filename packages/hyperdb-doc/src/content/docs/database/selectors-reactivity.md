---
title: Selectors & Reactivity
description: How HyperDB caches selectors, tracks scanned ranges, and re-runs only what a mutation actually affects.
sidebar:
  order: 6
---

Selectors aren't just queries; they're the unit of reactivity. HyperDB caches
selector results and re-runs them precisely: only when a mutation touches a range
the selector actually read. This page explains the model and the knobs you can
turn.

Selectors are ordinary generator code, so they can call other selectors, branch,
loop, and use shared helpers. Reactivity still comes from the indexed reads they
perform: every `selectFrom(...)` scan contributes ranges to the selector run.

## Range tracking

When a selector runs, the runtime records every index range it scans: table,
index, and bounds. If the selector calls child selectors, their scanned ranges
are part of the same dependency tree. The result is cached together with those
ranges.

When an action commits, the [`SubscribableDB`](/runtime/db/) notifies subscribers
with the rows that changed. A cached selector re-runs only if a changed row falls
inside one of the ranges it previously scanned; otherwise the cached value is
reused untouched.

This means a selector that reads `projectId = "p1"` is unaffected by a write to
`projectId = "p2"`, automatically. You never write invalidation logic.
For inserts, HyperDB checks the new row. For deletes, it checks the old row. For
upserts, it checks both old and new rows, so moving a row from one indexed range
to another invalidates both affected reads.

With `HybridDB`, a scan may be served from the in-memory cache or may fall
through to the primary store on a missing range. Reactivity tracks the logical
index range either way, independent of which storage tier returned the rows.

## Caching a selector

`initCachedSelector` gives you a subscribable store for a selector + args,
outside of React. (The React hooks are built on it.)

```ts
import { initCachedSelector } from "@will-be-done/hyperdb";

const store = initCachedSelector(db, projectTasks, { projectId: "p1" });

store.getSnapshot(); // current value
const unsub = store.subscribe(() => {
  console.log("changed:", store.getSnapshot());
});
// ... later
unsub();
```

The cache is keyed by the database, the selector identity, and a stable
serialization of the args. Argument key order doesn't matter:
`{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` resolve to the same cache entry.

## Caching layers

Cached selector reads always use the selector cache. If the runtime is
`HybridDB`, there is also an in-memory cache for rows and index ranges.

- The selector cache stores the result of running selector logic for one selector
  identity and one args object. This matters when the selector does more than a
  single scan: it may compose other selectors, branch, map rows, or build a
  derived result.
- The HybridDB in-memory cache stores rows and covered index ranges. This matters
  when selector args change: another selector run may not reuse the exact
  selector result, but it can still read already-loaded ranges from memory
  instead of going back to IndexedDB or SQLite.

## Preloading a selector

`preloadSelector` runs a selector through the root selector cache without
creating a React subscription. Use it in route loaders or hover prefetches when
you know the selector args a screen is about to render.

```ts
import { preloadSelector } from "@will-be-done/hyperdb";

await preloadSelector(db, projectTasks, { projectId: "p1" });
```

Preloading is execution-based, not static analysis. HyperDB runs the selector
with the current args and current data, so it warms the ranges that this run
actually touches. If the selector branches on loaded data, a different branch may
read different ranges later.

After preloading, the selector result can be reused by a later read with the same
selector and args. If a later mutation touches a range the selector read,
HyperDB will refresh it on the next preload or cached read.

With a `SubscribableDB(new HybridDB(primary, cache))`, the preload warms two
layers. First, HybridDB loads any missing index ranges from the primary store
into its in-memory cache. Then the selector result and its read ranges are
stored in the selector cache. A later `useAsyncSelector` with the same selector
identity and args can reuse that warmed entry when its async run starts, without
doing a synchronous cache read during render.

```ts
const categories = await preloadSelector(db, projectCategoriesByProjectId, {
  projectId,
});

await Promise.all(
  categories.map((category) =>
    preloadSelector(db, projectCategoryCardsForDisplayChildren, {
      projectCategoryId: category.id,
    }),
  ),
);
```

Match the render args exactly. The selector identity plus serialized args are
the cache key, so `{ limited: true }` and an omitted `limited` property are
different entries.

## Garbage collection

When the last subscriber of a cache entry unsubscribes, the entry is retained for
`gcTime` milliseconds (default `30_000`) before being dropped. This lets a value
survive brief gaps, such as a component unmounting and remounting, without
recomputing. While retained, the entry remains subscribed to DB changes so
non-overlapping mutations can advance its revision without a re-run, and
overlapping mutations can mark it stale for the next read.

```ts
// keep an unused entry around for 30s
initCachedSelector(db, projectTasks, { projectId: "p1" }, { gcTime: 30_000 });

// drop immediately when unsubscribed
initCachedSelector(db, projectTasks, { projectId: "p1" }, { gcTime: 0 });
```

## Memoization controls

Selectors take a `memoization` option:

```ts
const projectTasks = selector({
  name: "projectTasks",
  args: { projectId: v.string() },
  memoization: { root: true, selfChild: false }, // defaults
  handler: function* ({ projectId }) {
    /* ... */
  },
});
```

### `root` (default `true`)

Root memoization is the top-level cache described above. With `root: true`, calls
to `initCachedSelector` (and the React hooks) share a cached, subscribed entry
per args. Set `root: false` to opt out, so each use gets an uncached store that
still tracks ranges and stays reactive, but isn't shared or retained between uses.

```ts
memoization: {
  root: false;
}
```

### `selfChild` (default `false`)

When a selector is used as a child of another selector, `selfChild: true`
memoizes that nested selector's own subtree across the parent's reruns. If a
mutation forces the parent to re-run but doesn't affect this child's ranges, the
child's previous result and ranges are reused instead of recomputed. Turn it on
for expensive nested selectors that change less often than their parents.

```ts
memoization: {
  selfChild: true;
}
```

This is separate from root caching. `root` controls whether top-level reads
share a subscribed cache entry by selector args. `selfChild` controls whether a
nested selector can reuse its own previous subtree while a parent selector
re-runs.

## Subscriptions and revisions

Under the hood, a `SubscribableDB` keeps a monotonically increasing revision
number and a list of subscribers. Each committed transaction increments the
revision and calls subscribers with `(ops, traits, revision)`, where `ops` are
the `insert` / `upsert` / `delete` operations (including old and new row values).
The selector cache uses this to decide what to re-run. You can subscribe directly
for lower-level needs:

```ts
const unsub = db.subscribe((ops, traits, revision) => {
  // ops: InsertOp[] | UpsertOp[] | DeleteOp[] for this commit
});
```

## Practical guidance

- Default to the defaults. Root memoization on, `selfChild` off, `gcTime` 30_000.
  This is right for most selectors.
- Keep args minimal and serializable. They form the cache key. Avoid passing
  large or unstable objects.
- Prefer indexed reads over filtering large arrays in selector code. Reactivity
  is precise when the runtime can see the range you read.
- Use `preloadSelector` when you know the exact selector args a screen will
  render. Use `preloadTables` on `HybridDB` when an entire table should be warm.
- Reach for `selfChild` only when profiling (or the [devtool](/integrations/devtools/))
  shows an expensive nested selector recomputing needlessly.
- Reach for `root: false` for one-off selectors you don't want sharing a
  cache entry.
