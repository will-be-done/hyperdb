---
title: Why HyperDB?
description: The performance and full-stack constraints that HyperDB is designed around.
sidebar:
  order: 2
---

There is no shortage of ways to keep state in a TypeScript app, so it is fair
to ask what problem HyperDB is trying to solve. The short version: local-first
apps need efficient indexed data structures, precise invalidation, explicit
query execution, composable application logic, in-memory reads for instant UI
response, and a data layer that can also run on the backend.

This page explains those constraints. If you want to get going, skip to [How
HyperDB Works](/start/how-it-works/) and the
[Quickstart](/start/quickstart/).

## The data-structure problem

Local-first apps lean heavily on sorted collections. With
<a href="https://liveblocks.io/blog/how-crdts-and-sync-engines-keep-realtime-lists-ordered-with-fractional-indexing" target="_blank" rel="noopener noreferrer">fractional indexing</a>
you keep items ordered by giving each one an order token between its neighbours,
so reordering or inserting an item should touch a small amount of data. That
only holds if the underlying data structure can insert into a sorted collection
efficiently.

Plain client state often stores collections as sorted arrays, and a sorted array
is the wrong shape for this. If you keep the array immutable, inserting one item
means allocating a new array containing every existing element plus the new one.
If you mutate the array in place, inserting in the middle still shifts every
element after the insertion point. Either way, the operation is `O(n)`.

A B-tree is the standard data structure here: ordered iteration, range scans,
and `O(log n)` inserts and deletes. HyperDB is, at its core, a B-tree wrapper:
every table is backed by a [B+tree](/runtime/drivers/#in-memory), so inserting
one item into a sorted set of a hundred thousand does logarithmic work instead
of linear work.

## The query-plan problem

SQL is powerful, but the query text usually does not show the physical access
path. A `WHERE` clause can look simple while the database planner decides
whether to use an index, combine indexes, or scan the whole table. You can inspect
that with tools like `EXPLAIN`, but it is not explicit in the application code
that defines the read.

HyperDB makes the access path part of the selector. You choose the table index
with `selectFrom(table, "indexName")`, then build equality and range bounds over
that index. The runtime still gives you ordinary JavaScript selectors, but the
code tells you which index the read starts from and which range it scans.

## The notification problem

The second problem shows up as your app grows.

Coarse-grained state stores often have to wake every subscribed selector after a
write, then let each selector recompute and compare its result. That is `O(n)` in
the number of selectors, regardless of how small the change was. On a large
screen with thousands of live selectors, a single keystroke can mean thousands
of recomputations.

HyperDB tracks dependencies at the level of indexed ranges. Because every
selector reads through indexes, the runtime records exactly which index ranges it
scanned. When a mutation commits, only the selectors whose ranges actually
contain the changed rows re-run. See
[Reading Data](/database/reading-data/). A write to
`projectId = "p2"` does not wake a selector that read `projectId = "p1"`.

You get fine-grained invalidation without mutable observable objects. HyperDB
does not hand out proxies: every row it gives back is plain, immutable data,
frozen by the in-memory driver, and [deep-frozen end to end](/runtime/db/) when
you opt in with `freezeRows`. That means it works with React's rendering model
directly, with no wrappers and no proxies leaking into your view layer.

## The backend problem

Imagine you have a local-first app and now need a server, to validate writes, to
run the same business logic authoritatively, or to merge changes from many
clients. With a frontend-only state layer you usually have two options:

1. Load everything into memory and run your selectors and actions against it.
   This works for one user, but a server holds _many_ users' data at once. Keeping
   it all resident is memory-hungry and adds real startup latency while you hydrate
   it.
2. Reimplement the logic in SQL or some other backend stack. Now you maintain
   two copies of the same rules, and every divergence is a bug waiting to happen.

HyperDB avoids that split. Because a table is a B-tree, and B-trees are what
many databases are built on, the same schema, selectors, and actions can run
against a persistent store on the server. Today that store is
[SQLite](/runtime/drivers/#backend-native-sqlite) (MongoDB and PostgreSQL are not
supported for now). The runtime reads through the database's own
indexes and pulls in only the rows a given selector or action touches; it
does not hydrate the whole dataset into memory. You can share data logic between
the client and server. The [Sync Engine guide](/guides/sync-engine/) outlines a
server using the same change-tracking code as clients.

## Synchronous on the frontend

On the frontend, against the [in-memory driver](/runtime/drivers/#in-memory),
selectors and actions execute synchronously, start to finish, with no
`await` in the middle. This is the whole reason HyperDB is built on
[generators](/start/how-it-works/): a generator can describe code that runs either
synchronously or asynchronously, so the _same_ selector or action works against a
sync in-memory driver and against an async driver like IndexedDB without being
rewritten.

When the driver is synchronous, the runtime does not yield back to the event loop in
the middle of a read or a write. There's no microtask hop, no promise to schedule,
no frame where the work is half-done. A dispatch runs to completion and the result
is available immediately, so a click can update the store and the UI in the same
tick. This keeps the interactive path out of the promise/microtask queue.

You keep the async path for what needs it (persistence, IndexedDB,
server SQLite), but the interactive hot path, the in-memory tier that the UI
reads and writes, stays fully synchronous and responsive.

That same generator flexibility also powers `HybridDB`. Instead of loading
everything into memory up front, a read checks the in-memory cache first and, on
a miss, runs the _same_ query against a primary store such as IndexedDB or async
SQLite. The rows are cached back into memory, so repeated reads of the same
index range stay fast. Because a selector is just a description, it runs
unchanged either way: you trade purely synchronous reads for async reads that
can fall through to storage, while startup stays quick and memory stays low.
Writes update the cache first for an immediate UI response, then flush to the
primary store in order.

`PreloadedHybridDB` offers a different memory/startup tradeoff. It reads each
table once at startup to build every index with entity IDs as leaves, but does
not retain the rows themselves. Scans therefore resolve bounds entirely in
memory and batch-load only entity IDs that have not already been cached. This is
useful when the index projection fits in memory while the complete dataset does
not.

## Composable app logic

HyperDB selectors and actions compose like ordinary code. A selector can call
another selector, map over the result, branch, and call more selectors. An action
can read with a selector, write, call another action, then read again, all inside
one transaction. You do not have to split logic between a query language, React
components, and a separate mutation layer just to express the order of work.

That is an intentional tradeoff. Because selectors are real JavaScript, the full
read plan is not always knowable without running the code. A selector may branch
on a row it just loaded, and the next index range may depend on that branch. So
preloading is execution-based: run the selector, or warm known tables/ranges
ahead of time. HyperDB can't statically extract a perfect preload plan
from arbitrary control flow.

## Every query is observable

Because reads go through declarative queries rather than ad-hoc property access,
HyperDB records what each selector and action did: which indexes were
scanned, how many rows came back, and how long each step took. It surfaces all of
that in a built-in [devtool](/integrations/devtools/).

![The HyperDB devtool showing a trace list on the left and the Call Tree of a selector on the right](../../../assets/devtool-call-tree.png)

Each dispatch and selector run becomes a trace you can sort by duration or rows
fetched. Open one and you get a full call tree: the selector at the top, every nested
selector it composed, and at the leaves the actual index reads, like
`select project_categories.byProjectIdOrderToken → 3 rows`, each annotated with
its own timing and row count. When a view is slow, you can see precisely which
sub-query or which index is responsible, instead of guessing.

This kind of insight comes from reading data through queries. A state
library where components reach into plain objects has nothing to trace; HyperDB's
declarative reads give it a complete, structured picture of every computation.

## It's still just JavaScript

A fair worry about "use a database on the backend" is that it means writing SQL
and thinking in query languages. HyperDB doesn't ask that of you. You write
ordinary JavaScript (loops, conditionals, function calls) in your selectors and
actions. What HyperDB provides underneath is fast indexed lookups and inserts,
not a query language to learn. The mental model is the same on the client and
the server: plain JS logic over typed, indexed, reactive data.

## Why not SQLite?

If the same selectors and actions already run on server SQLite, the natural
question is why not run SQLite in the browser too, shipping one SQL dialect to both
ends, the way <a href="https://www.powersync.com/" target="_blank" rel="noopener noreferrer">PowerSync</a>
and similar tools do. HyperDB can persist to IndexedDB instead. Here's the
reasoning.

SQLite in the browser is heavy. A browser has no native SQLite, so you ship a
WebAssembly build, a binary the user downloads and instantiates before the app
can read a single row. Then every read and write crosses the JS↔WASM boundary,
encoding and decoding strings each way. Because HyperDB is schemaless at the
storage layer (rows are documents, not columns under a fixed SQL schema), values
are stored as JSON, so each row also pays `JSON.stringify` on the way in and
`JSON.parse` on the way out. Each cost is small in isolation, but they add up on
hot paths.

IndexedDB is a good fit for this storage layer. It's a native, document-oriented
store with indexes, which matches HyperDB's storage model, with no WASM to ship
and no OPFS or IndexedDB-VFS layer to route SQLite through. Its raw API is
awkward, but the [IndexedDB driver](/runtime/drivers/#indexeddb) hides it behind
the same schema, selectors, and actions you use elsewhere.

One practical setup is `HybridDB`: IndexedDB or async SQLite as the primary
store, plus an [in-memory](/runtime/drivers/#in-memory) B-tree cache for hot
index ranges. Reads use memory when the range is cached and fall through to the
primary store when it is not. Writes update the cache first for an immediate UI
response, then flush to the primary store in order.

SQLite also does not provide the same reactivity signal. Even setting the bundle
and serialization costs aside, a SQL query does not carry an application-level
record of _which index ranges it read_. When any row in a table changes, you
have no direct way to know which subscribed queries it could have touched, so
you re-run all of them. That's the [notification problem](#the-notification-problem)
all over again. HyperDB tracks the exact index ranges each selector scanned, so
a write wakes only the selectors that overlap it. The in-memory HyperDB tier
gives you range-tracked reactivity without needing to infer dependencies from
SQL.

## Why not IVM?

Incremental View Maintenance (IVM) is a strong idea: keep query results up to
date by applying small deltas when source data changes, instead of recomputing
the whole view. Systems such as
<a href="https://tanstack.com/db/latest" target="_blank" rel="noopener noreferrer">TanStack DB</a>
and <a href="https://zero.rocicorp.dev/" target="_blank" rel="noopener noreferrer">Zero</a>
use this style of local query engine to make complex derived data update
quickly.

IVM solves a lot of the same problems HyperDB cares about. It can give you
granular notifications, keep derived views up to date without re-running every
query from scratch, and make query execution observable enough for useful
devtools. When paired with the right storage layer, it can also sit on top of
efficient indexed data structures instead of plain arrays.

HyperDB starts from a different tradeoff. IVM usually means learning a query
language or query-builder API, often with SQL-like joins, projections, grouping,
and planner rules. That can be the right model, especially for complex relational
views, but the execution path is still mostly owned by the query engine. From
the application code alone, it is hard to see whether a read starts from a
B-tree lookup, a join-maintenance structure, or a broader scan.

HyperDB's first goal is to let you write ordinary JavaScript while keeping reads
explicit. A selector can use loops, conditionals, function calls, and shared
helpers, but its indexed reads still name the table index and bounds they scan.
You get a data layer that feels like code, with database-shaped primitives
underneath.

IVM is still compatible with HyperDB's model. HyperDB already has typed tables,
indexed reads, range tracking, transactions, and change notifications. An IVM
layer could sit on top as another execution engine: it would need a data gateway
that can fetch indexed ranges and receive mutations, then maintain derived views
incrementally. That is a possible future extension, not a contradiction of the
core design.

## In short

HyperDB exists because local-first apps need:

| Need                                            | HyperDB                        |
| ----------------------------------------------- | ------------------------------ |
| Cheap inserts into sorted data                  | `O(log n)` with B-tree indexes |
| Explicit read access paths                      | Selectors name the index/range |
| Composable selectors and actions                | Plain generator code           |
| Update only affected selectors                  | Fine-grained, range-tracked    |
| Plain React data                                | Immutable rows, no proxies     |
| Runs the same code on the backend               | Yes (SQLite today)             |
| Per-action/selector + query tracing & call tree | Built-in devtool               |

If those rows describe problems you have, the rest of these docs show how HyperDB
solves them. Start with [How HyperDB Works](/start/how-it-works/).
