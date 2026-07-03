# HyperDB Devtool Notes

The React devtool lives in `packages/hyperdb-devtool`. Core HyperDB owns the
framework-agnostic tracing primitives under `packages/hyperdb/src/hyperdb/tracing`;
the devtool package renders those traces with React and goober.

This file is a maintenance note, not a product spec. Keep it aligned with the
current implementation when tracing, runtime execution, or the devtool UI
changes.

## Public API

Install the devtool package separately:

```bash
npm install @will-be-done/hyperdb-devtool
```

Use the React entry point:

```tsx
import { HyperDBDevtools } from "@will-be-done/hyperdb-devtool/react";

<HyperDBDevtools db={db} />;
```

Exports from `@will-be-done/hyperdb-devtool/react`:

- `HyperDBDevtools`: floating button plus docked panel.
- `HyperDBDevtoolsPanel`: embedded panel without the floating button.
- tracing exports re-exported from `@will-be-done/hyperdb/tracing`.

`HyperDBDevtools` props:

| Prop | Meaning |
| ---- | ------- |
| `db?: SubscribableDB` | Trace one DB explicitly. If omitted, the devtool tries `DBProvider` context and registered DB discovery. |
| `initialIsOpen?: boolean` | Initial panel state before localStorage is read. |
| `position?: "top" \| "bottom" \| "left" \| "right"` | Dock position, default `"bottom"`. |
| `buttonPosition?: "top-left" \| "top-right" \| "bottom-left" \| "bottom-right"` | Floating button position, default `"bottom-right"`. |
| `maxTraces?: number` | Visible/retained trace cap for the devtool view, default `200`. |
| `theme?: "dark" \| "light" \| "system"` | Theme selection, default `"system"`. |

## Runtime Tracing

Core tracing is intentionally React-free. Runtime and command code may import
only framework-agnostic tracing primitives.

Tracing captures top-level action and selector executions as root traces:

- An action calling another action creates one root trace with a child action
  frame.
- An action calling a selector attaches the selector as a child frame.
- A selector calling another selector attaches the nested selector as a child
  frame.
- Raw generator work without selector/action metadata may be recorded as
  `unknown` only when the runner can do so without changing existing behavior.

Each trace records:

- root metadata: kind, name, args, timing, status, error summary, DB id/label
- call tree frames for nested selectors/actions
- select events: table, index, where, bounds, limit, order, source, duration,
  result count, result preview, status/error
- mutation events: insert/upsert/delete, table, ids, old rows, new rows,
  duration, status/error

Trace payloads use safe serialization so circular, function, symbol, bigint, or
otherwise unserializable values do not crash the UI.

## Activation And Retention

The global `hyperDBTraceStore` is the default tracer. It stores traces in an
internal in-memory `SubscribableDB` with registration and tracing disabled, so
the devtool does not discover or trace itself.

Tracing is active only while a devtool listener is mounted:

- `hyperDBTraceStore.activate()` increments an activation count and returns a
  cleanup function.
- When inactive, tracing should stay cheap and avoid storing trace payloads.
- Root traces are committed in small batches.
- `maxTraces` limits retained roots; older traces are pruned.
- `clear()` removes all traces; `clearDB(dbId)` removes traces for one DB.

Raw `DB` construction registers app DB metadata for discovery. `SubscribableDB`
shares the wrapped DB id so trace filtering stays stable. Internal tracing DBs
must opt out with `register: false` and `tracer: "disabled"`.

## HybridDB Signals

Select events can report their source:

- `in-mem`: the read was served from the in-memory cache.
- `persist`: the read fell through to the primary store.

A root trace is marked `inMem` when none of its select events fell through to a
persistent scan. Mutations do not disqualify the trace: HybridDB applies writes
to the in-memory cache during the trace, then flushes to the primary store
separately.

The devtool surfaces this in two places:

- trace rows get an `in-mem` badge when every select was served from memory
- call tree operations show `in-mem` or `persist` badges per select

The trace list also has a "skip cached" filter, which hides fully cached traces
when you want to focus on reads that touched persistent storage.

## UI Shape

The UI is compact and debugger-oriented:

- floating `HDB` button
- docked panel or embedded panel
- trace list on the left, details on the right
- DB selector when multiple DBs are discovered
- filters for all/selectors/actions and cached traces
- sorting by creation time, duration, or rows fetched
- details tabs: Overview, Data, Mutations, Call Tree
- clear button for all visible traces or the selected DB

The selected details tab stays selected when switching traces, which makes it
easier to compare call trees, query plans, or mutation payloads.

Layout state is persisted in localStorage where available:

- open/closed state
- trace list width
- panel height
- kind filter
- sort field and direction
- skip-cached filter

The panel should stay usable in narrow containers. On narrow layouts, selected
trace details open over the trace list so the list keeps its scroll position.

## Styling Constraints

- Use goober for all devtool styling.
- Do not add Tailwind, CSS modules, global CSS, or a dependency on app styles.
- Do not import React from core HyperDB runtime, commands, tracing, or drivers.
- Keep the devtool package as the only React UI owner.

## Test Coverage

Keep coverage focused on behavior that is easy to regress:

- trace store activation/deactivation
- retention cap and clearing
- root trace lifecycle success/error
- nested action/selector frames
- select events with table, index, bounds, row counts, source, and errors
- mutation events with old/new row payloads where available
- DB registration and discovery
- internal trace store DB not registering itself
- no stored devtool query traces for the devtool's own trace-list selectors
- trace sorting and filtering, including rows fetched and skip-cached
- panel rendering, trace selection, tab persistence, DB selection, clear button,
  localStorage state, and explicit `db` prop behavior

## Validation

Run the package checks that match the change:

```bash
pnpm --filter @will-be-done/hyperdb test
pnpm --filter @will-be-done/hyperdb ts
pnpm --filter @will-be-done/hyperdb-devtool test
pnpm --filter @will-be-done/hyperdb-devtool ts
pnpm --filter @will-be-done/hyperdb-devtool build
```

Avoid formatters or build steps that rewrite unrelated files.
