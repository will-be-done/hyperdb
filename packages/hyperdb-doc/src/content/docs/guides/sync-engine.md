---
title: "[WIP] Building a Sync Engine"
description: A worked example covering change tracking, CRDT-style merge, and a two-tier persistent setup built on HyperDB primitives.
sidebar:
  order: 2
---

HyperDB does not have a built-in sync layer yet, but it already gives you the
primitives a sync engine needs: transactional actions, lifecycle hooks that run
inside the committing transaction, traits for tagging the origin of a write, and
the ability to wire multiple databases together.

We plan to release sync primitives soon. They will unlock:

1. Client and server change tracking
1. Sending and applying changes between clients and servers
1. Cross-tab syncing

The design will work like this:

1. A change-tracking table that records what changed and when.
1. Lifecycle hooks that append change records on every mutation.
1. Merge actions that apply remote changesets with last-write-wins semantics.
1. A two-tier runtime: an in-memory tier for the UI, a persistent tier for
   durability, plus the glue that hydrates, persists, and syncs.
1. Each tab broadcasts changes so other tabs can apply them.

Because actions can run on the server too, the server can act as another peer:
it applies incoming changes, runs the same merge logic, and sends new changes
back to clients.

I plan to port this from the current Will Be Done implementation. You can see
how it works in the store loader, shared change-tracking slice, and API startup
code:

1. [Store loader](https://github.com/will-be-done/will-be-done/blob/d4564f01f0fe69c772413be3c23b1f97508f05f8/apps/web/src/store/load.ts)
2. [Shared change-tracking slice](https://github.com/will-be-done/will-be-done/blob/d4564f01f0fe69c772413be3c23b1f97508f05f8/apps/slices/src/common/changes.ts)
3. [API startup code](https://github.com/will-be-done/will-be-done/blob/d4564f01f0fe69c772413be3c23b1f97508f05f8/apps/api/src/start.ts#L112)
