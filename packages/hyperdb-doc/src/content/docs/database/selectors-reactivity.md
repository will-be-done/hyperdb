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

## Range tracking

When a selector runs, the runtime records every index range it scans. The result
is cached together with those ranges. When an action commits, the
[`SubscribableDB`](/runtime/db/) notifies subscribers with the rows that changed.
A cached selector re-runs only if a changed row falls inside one of the
ranges it previously scanned; otherwise the cached value is reused untouched.

This means a selector that reads `projectId = "p1"` is unaffected by a write to
`projectId = "p2"`, automatically. You never write invalidation logic.

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

## Preloading a selector

`preloadSelector` runs a selector through the root selector cache without
creating a React subscription. Use it in route loaders or hover prefetches when
you know the selector args a screen is about to render.

```ts
import { preloadSelector } from "@will-be-done/hyperdb";

await preloadSelector(db, projectTasks, { projectId: "p1" });
```

Preloaded entries stay range-aware while they remain in the selector cache. If a
later mutation misses the ranges the selector read, another preload with the same
args reuses the cached result even though the DB revision changed. If a mutation
does touch those ranges and nothing is subscribed, the entry is marked stale and
re-runs lazily on the next preload or cached selector read.

With a `SubscribableDB(new HybridDB(primary, cache))`, the preload does two
things: it runs the selector against the HybridDB so missing persistent ranges
are loaded into the in-memory cache, then it primes the in-memory selector cache
entry that React reads synchronously. A later `useAsyncSelector` with the same
selector identity and args can start from that warmed snapshot.

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
`gcTime` milliseconds (default 30000) before being dropped. This lets a value
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

- Default to the defaults. Root memoization on, `selfChild` off, `gcTime` 3000. This is right for most selectors.
- Keep args minimal and serializable. They form the cache key. Avoid passing
  large or unstable objects.
- Reach for `selfChild` only when profiling (or the [devtool](/integrations/devtools/))
  shows an expensive nested selector recomputing needlessly.
- Reach for `root: false` for one-off selectors you don't want sharing a
  cache entry.
