---
title: Why HyperDB?
description: Why I built another database — the performance and full-stack problems with Redux and MobX that motivated HyperDB.
sidebar:
  order: 2
---

There is no shortage of state libraries for TypeScript, so it is fair to ask why
the world needs another one. I built HyperDB because the tools I was reaching for
— Redux and MobX — kept losing on two fronts that matter most for local-first
apps: **performance** and the ability to **run the same code on the backend**.

This page explains the specific problems that pushed me to build it. If you just
want to get going, skip to [How HyperDB Works](/start/how-it-works/) and the
[Quickstart](/start/quickstart/).

## The data-structure problem

Local-first apps lean heavily on **sorted collections**. With
[fractional indexing](https://observablehq.com/@dgreensp/implementing-fractional-indexing)
you keep items ordered by giving each one an order token between its neighbours,
so reordering or inserting an item is supposed to be cheap — you only touch a
single token. But that promise only holds if the underlying data structure can
insert into a sorted collection cheaply.

Redux and MobX both store collections as plain **sorted arrays**, and a sorted
array is the wrong shape for this:

- **Redux** is immutable by design. Inserting one item into a sorted list means
  allocating a **new array** containing every existing element plus the new one.
  That is `O(n)` work and `O(n)` garbage on every single insert.
- **MobX** is better, because you mutate in place rather than rebuild. But
  splicing a value into the middle of a sorted array still has to shift every
  element after the insertion point, so under the hood it is still `O(n)`.

A **B-tree** is the textbook solution here: ordered iteration, range scans, and
`O(log n)` inserts and deletes. Neither Redux nor MobX gives you one. HyperDB is,
at its core, a B-tree wrapper — every table is backed by a real
[B+tree](/runtime/drivers/#in-memory), so inserting one item into a sorted set of
a hundred thousand stays fast instead of degrading linearly.

## The notification problem

The second problem shows up as your app grows.

In Redux, every dispatch notifies **every** connected selector, which then has to
recompute and compare its result to decide whether its component should re-render.
That is `O(n)` in the number of selectors, regardless of how small the change was.
On a large screen with thousands of live selectors, a single keystroke can mean
thousands of recomputations.

MobX solves this with fine-grained observation: it knows exactly which observables
each computed value read, so only the affected ones re-run. HyperDB does the same
thing, but at the level of **data ranges instead of object fields**. Because every
selector reads through indexes, the runtime records exactly which index ranges it
scanned. When a mutation commits, only the selectors whose ranges actually contain
the changed rows re-run — see [Selectors & Reactivity](/database/selectors-reactivity/).
A write to `projectId = "p2"` simply never wakes a selector that read
`projectId = "p1"`.

So you get MobX-style granularity (with one honest caveat: tracking is at the
range/row level, not per individual field), **without MobX's downside**. MobX
relies on mutable, observable objects and asks you to wrap components in
`observer()` — which I have always felt is a hack against React's grain. HyperDB
never hands out mutable data: every row that goes into the store is
[deeply frozen](/runtime/db/), so what your components receive is plain immutable
data. That means it composes with React's rendering model directly — no
`observer()`, no proxies leaking into your view layer.


## The backend problem

This is the reason I actually started building HyperDB.

Imagine you have a local-first app and now need a server — to validate writes, to
run the same business logic authoritatively, or to merge changes from many
clients. With Redux or MobX you have two bad options:

1. **Load everything into memory** and run your selectors and actions against it.
   This works for one user, but a server holds *many* users' data at once. Keeping
   it all resident is memory-hungry and adds real startup latency while you hydrate
   it.
2. **Reimplement the logic** in SQL or some other backend stack. Now you maintain
   two copies of the same rules, and every divergence is a bug waiting to happen.

HyperDB removes the choice. Because a table is just a B-tree, and B-trees are what
real databases are built on, the **same** schema, selectors, and actions run
against a persistent store on the server. Today that store is
[SQLite](/runtime/drivers/#backend-native-sqlite) (MongoDB and PostgreSQL are not
supported for now). The runtime reads through the database's own
indexes and pulls in **only the rows a given selector or action touches** — it
never loads the whole dataset into memory. You write your data logic once and run
it on both ends of the wire. The [Sync Engine guide](/guides/sync-engine/) shows a
server doing exactly this, sharing its change-tracking code with every client.

## Synchronous on the frontend

On the frontend, against the [in-memory driver](/runtime/drivers/#in-memory),
selectors and actions execute **synchronously** — start to finish, with no
`await` in the middle. This is the whole reason HyperDB is built on
[generators](/start/how-it-works/): a generator can describe code that runs either
synchronously or asynchronously, so the *same* selector or action works against a
sync in-memory driver and against an async driver like IndexedDB without being
rewritten.

When the driver is synchronous, the runtime never yields back to the event loop in
the middle of a read or a write. There's no microtask hop, no promise to schedule,
no frame where the work is half-done. A dispatch runs to completion and the result
is available immediately, so a click can update the store and the UI in the same
tick. That is what makes the frontend feel instant — sync code simply executes far
faster than the same code broken up by `await`, because nothing pauses to wait for
the event loop.

You keep the async path for what genuinely needs it (persistence, IndexedDB,
server SQLite), but the interactive hot path — the in-memory tier that the UI
reads and writes — stays fully synchronous and responsive.

## Every query is observable

Because reads go through declarative queries rather than ad-hoc property access,
HyperDB knows exactly what each selector and action did: which indexes were
scanned, how many rows came back, and how long each step took. It surfaces all of
that in a built-in [devtool](/integrations/devtools/).

![The HyperDB devtool showing a trace list on the left and the Call Tree of a selector on the right](../../../assets/devtool-call-tree.png)

Every dispatch and selector run becomes a **trace** you can sort by duration. Open
one and you get a full **call tree**: the selector at the top, every nested
selector it composed, and at the leaves the actual index reads —
`select project_categories.byProjectIdOrderToken → 3 rows` — each annotated with
its own timing and row count. When a view is slow, you can see precisely which
sub-query or which index is responsible, instead of guessing.

This kind of insight is only possible *because* data is read by queries. A state
library where components reach into plain objects has nothing to trace; HyperDB's
declarative reads give it a complete, structured picture of every computation.

## It's still just JavaScript

A fair worry about "use a database on the backend" is that it means writing SQL
and thinking in query languages. HyperDB doesn't ask that of you. You write
ordinary JavaScript — loops, conditionals, function calls — in your selectors and
actions. What HyperDB provides underneath is **fast indexed lookups and inserts**,
not a query language to learn. The mental model is the same on the client and the
server: plain JS logic over typed, indexed, reactive data.

## In short

HyperDB exists because local-first apps need:

| Need | Redux | MobX | HyperDB |
| --- | --- | --- | --- |
| Cheap inserts into sorted data | `O(n)` (new array) | `O(n)` (array shift) | `O(log n)` (B-tree) |
| Update only affected selectors | `O(selectors)` per dispatch | Fine-grained | Fine-grained (range-tracked) |
| Works with React without hacks | Yes | Needs `observer()` | Yes |
| Runs the same code on the backend | No | No | Yes (only SQLite for now) |
| Per-action/selector + query tracing & call tree | — | — | Built-in devtool |

If those rows describe problems you have, the rest of these docs show how HyperDB
solves them. Start with [How HyperDB Works](/start/how-it-works/).
