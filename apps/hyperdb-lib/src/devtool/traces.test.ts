import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { select } from "../hyperdb";
import {
  createTraceFrameMeta,
  endTraceSuccess,
  hyperDBTraceStore,
  startRootTrace,
  type RootTrace,
  type TraceFrame,
} from "../hyperdb/tracing/store";
import {
  traceStoreTraceSelection,
  traceStoreTraces,
} from "./traces";

const traceFrame = (cached = false): TraceFrame => ({
  id: cached ? "cached-frame" : "frame",
  kind: "selector",
  name: "frame",
  arg: undefined,
  startedAt: 0,
  status: "success",
  cached,
  children: [],
  commandIds: [],
  mutationIds: [],
});

const trace = (overrides: Partial<RootTrace>): RootTrace => ({
  id: overrides.id ?? "trace-1",
  kind: overrides.kind ?? "selector",
  name: overrides.name ?? "trace",
  arg: undefined,
  startedAt: overrides.startedAt ?? 0,
  durationMs: overrides.durationMs,
  status: overrides.status ?? "success",
  frames: [traceFrame()],
  commandEvents: [],
  mutationEvents: [],
  ...overrides,
});

const flushTraceCommits = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 120);
  });
};

describe("devtool trace selectors", () => {
  beforeEach(() => {
    hyperDBTraceStore.setMaxTraces(200);
    hyperDBTraceStore.clear();
  });

  afterEach(() => {
    hyperDBTraceStore.clear();
  });

  it("returns up to the requested limit after applying the kind filter", () => {
    hyperDBTraceStore.addTrace(
      trace({ id: "selector-1", name: "selector-1", durationMs: 100 }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "selector-2", name: "selector-2", durationMs: 90 }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "selector-3", name: "selector-3", durationMs: 80 }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "action-1",
        kind: "action",
        name: "action-1",
        durationMs: 70,
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "action-2",
        kind: "action",
        name: "action-2",
        durationMs: 60,
      }),
    );

    const traces = select(
      hyperDBTraceStore.getDB(),
      traceStoreTraces({
        maxTraces: 2,
        kind: "action",
        sortField: "duration",
        sortDir: "desc",
      }),
    );

    expect(traces.map((item) => item.name)).toEqual(["action-1", "action-2"]);
  });

  it("returns up to the requested limit after skipping cached traces", () => {
    hyperDBTraceStore.addTrace(
      trace({
        id: "cached-1",
        name: "cached-1",
        durationMs: 100,
        frames: [traceFrame(true)],
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "cached-2",
        name: "cached-2",
        durationMs: 90,
        frames: [traceFrame(true)],
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "visible-1", name: "visible-1", durationMs: 80 }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "visible-2", name: "visible-2", durationMs: 70 }),
    );

    const selection = select(
      hyperDBTraceStore.getDB(),
      traceStoreTraceSelection({
        maxTraces: 2,
        kind: "all",
        skipCached: true,
        sortField: "duration",
        sortDir: "desc",
      }),
    );

    expect(selection.visibleTraces.map((item) => item.name)).toEqual([
      "visible-1",
      "visible-2",
    ]);
  });

  it("does not record trace-list selector reads as devtool traces", () => {
    hyperDBTraceStore.addTrace(trace({ id: "visible-1", name: "visible-1" }));

    const traces = select(
      hyperDBTraceStore.getDB(),
      traceStoreTraces({
        maxTraces: 10,
        kind: "all",
        sortField: "created",
        sortDir: "desc",
      }),
    );

    expect(traces.map((item) => item.name)).toEqual(["visible-1"]);
  });

  it("returns traces committed through the batched trace store", async () => {
    const deactivate = hyperDBTraceStore.activate();
    const context = startRootTrace(
      createTraceFrameMeta("action", "committed-action", undefined),
      hyperDBTraceStore,
    )!;
    endTraceSuccess(context);

    expect(
      select(
        hyperDBTraceStore.getDB(),
        traceStoreTraces({
          maxTraces: 10,
          kind: "all",
          sortField: "created",
          sortDir: "desc",
        }),
      ),
    ).toEqual([]);

    await flushTraceCommits();

    const traces = select(
      hyperDBTraceStore.getDB(),
      traceStoreTraces({
        maxTraces: 10,
        kind: "all",
        sortField: "created",
        sortDir: "desc",
      }),
    );

    expect(traces.map((item) => item.name)).toEqual(["committed-action"]);
    deactivate();
  });

  it("clears the trace store directly", () => {
    hyperDBTraceStore.addTrace(trace({ id: "visible-1", name: "visible-1" }));

    hyperDBTraceStore.clear();

    expect(
      select(
        hyperDBTraceStore.getDB(),
        traceStoreTraces({
          maxTraces: 10,
          kind: "all",
          sortField: "created",
          sortDir: "desc",
        }),
      ),
    ).toEqual([]);
  });
});
