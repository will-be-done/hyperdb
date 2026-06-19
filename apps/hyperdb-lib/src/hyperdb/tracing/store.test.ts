import { describe, expect, it } from "vitest";
import {
  beginMutationEvent,
  beginSelectEvent,
  HyperDBTraceStore,
  createTraceFrameMeta,
  endMutationEventSuccess,
  endSelectEventSuccess,
  endTraceError,
  endTraceSuccess,
  enterFramePath,
  startRootTrace,
  traceRootsRuntimeTable,
} from "./store";
import { select } from "../commands/selector/selector";
import { selectFrom } from "../commands/selector/builder";

const flushTraceCommits = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 120);
  });
};

const selectCommittedTraceNames = (store: HyperDBTraceStore): string[] =>
  select(
    store.getDB(),
    (function* () {
      const rows = yield* selectFrom(traceRootsRuntimeTable, "byCreatedSeq")
        .order("desc")
        .limit(10);
      return rows.map((row) => row.name);
    })(),
  );

const selectCommittedTraces = (store: HyperDBTraceStore) =>
  select(
    store.getDB(),
    (function* () {
      const rows = yield* selectFrom(traceRootsRuntimeTable, "byCreatedSeq")
        .order("desc")
        .limit(10);
      return store.resolveTraceRows(rows);
    })(),
  );

describe("devtool tracing store", () => {
  it("can be activated and deactivated", () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();

    expect(store.isActive()).toBe(true);

    deactivate();

    expect(store.isActive()).toBe(false);
  });

  it("does not store traces while inactive", () => {
    const store = new HyperDBTraceStore();
    const context = startRootTrace(
      createTraceFrameMeta("action", "inactive", undefined),
      store,
    );

    expect(context).toBeUndefined();
    expect(selectCommittedTraceNames(store)).toEqual([]);
  });

  it("starts load-start traces without listeners", () => {
    const store = new HyperDBTraceStore();
    const context = startRootTrace(
      createTraceFrameMeta("action", "traced", undefined, {
        trace: { enabled: true, startOn: "load" },
      }),
      store,
    );

    expect(context).toBeDefined();
    expect(selectCommittedTraceNames(store)).toEqual([]);
  });

  it("does not store traces when tracing is disabled", () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    const context = startRootTrace(
      createTraceFrameMeta("action", "disabled", undefined, {
        trace: { enabled: false, startOn: "devtoolOpen" },
      }),
      store,
    );

    expect(context).toBeUndefined();
    expect(selectCommittedTraceNames(store)).toEqual([]);

    deactivate();
  });

  it("keeps the newest traces within the retention cap", async () => {
    const store = new HyperDBTraceStore(2);
    const deactivate = store.activate();

    for (const name of ["one", "two", "three"]) {
      const context = startRootTrace(
        createTraceFrameMeta("action", name, undefined),
        store,
      );
      expect(context).toBeDefined();
      endTraceSuccess(context!);
    }

    await flushTraceCommits();

    expect(selectCommittedTraceNames(store)).toEqual(["three", "two"]);

    deactivate();
  });

  it("does not notify trace db subscribers when starting a root trace", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    let notifyCount = 0;
    const unsubscribeDB = store.getDB().subscribe(() => {
      notifyCount += 1;
    });

    const context = startRootTrace(
      createTraceFrameMeta("action", "async-db-subscriber", undefined),
      store,
    )!;

    await flushTraceCommits();
    expect(notifyCount).toBe(0);

    unsubscribeDB();
    deactivate();
  });

  it("does not notify trace db subscribers for trace events before completion", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    let notifyCount = 0;
    const unsubscribeDB = store.getDB().subscribe(() => {
      notifyCount += 1;
    });

    const context = startRootTrace(
      createTraceFrameMeta("action", "events-before-completion", undefined),
      store,
    )!;
    const selectEvent = beginSelectEvent(context, context.rootFrame, {
      tableName: "tasks",
      index: "byId",
      where: [],
      bounds: [],
    });
    endSelectEventSuccess(context, selectEvent, []);
    const mutationEvent = beginMutationEvent(context, context.rootFrame, {
      kind: "upsert",
      tableName: "tasks",
      rows: [],
    });
    endMutationEventSuccess(context, mutationEvent);

    await flushTraceCommits();
    expect(notifyCount).toBe(0);

    endTraceSuccess(context);

    expect(notifyCount).toBe(0);

    await flushTraceCommits();
    expect(notifyCount).toBe(1);

    unsubscribeDB();
    deactivate();
  });

  it("commits finished traces after the batch delay", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    const context = startRootTrace(
      createTraceFrameMeta("action", "batched", undefined),
      store,
    )!;

    endTraceSuccess(context);

    expect(context.trace.name).toBe("batched");
    expect(selectCommittedTraceNames(store)).toEqual([]);

    await flushTraceCommits();
    expect(selectCommittedTraceNames(store)).toEqual(["batched"]);

    deactivate();
  });

  it("flushes multiple completed traces in one scheduled batch", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    let notifyCount = 0;
    const unsubscribeDB = store.getDB().subscribe(() => {
      notifyCount += 1;
    });

    for (const name of ["one", "two"]) {
      const context = startRootTrace(
        createTraceFrameMeta("action", name, undefined),
        store,
      )!;
      endTraceSuccess(context);
    }

    expect(notifyCount).toBe(0);

    await flushTraceCommits();
    expect(notifyCount).toBe(1);
    expect(selectCommittedTraceNames(store)).toEqual(["two", "one"]);

    unsubscribeDB();
    deactivate();
  });

  it("discards queued traces when cleared before the batch flush", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    const context = startRootTrace(
      createTraceFrameMeta("action", "discarded", undefined),
      store,
    )!;
    endTraceSuccess(context);

    store.clear();
    await flushTraceCommits();

    expect(selectCommittedTraceNames(store)).toEqual([]);

    deactivate();
  });

  it("discards queued DB traces when clearing that DB before the batch flush", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    const db = {
      getId: () => "db-a",
      getDBName: () => "DB A",
    };
    const context = startRootTrace(
      createTraceFrameMeta("action", "discarded-db", undefined),
      store,
      db,
    )!;
    endTraceSuccess(context);

    store.clearDB("db-a");
    await flushTraceCommits();

    expect(selectCommittedTraceNames(store)).toEqual([]);

    deactivate();
  });

  it("ignores non-finite max trace counts", async () => {
    const store = new HyperDBTraceStore(2);
    const deactivate = store.activate();

    for (const name of ["one", "two", "three"]) {
      const context = startRootTrace(
        createTraceFrameMeta("action", name, undefined),
        store,
      );
      expect(context).toBeDefined();
      endTraceSuccess(context!);
    }

    store.setMaxTraces(Number.NaN);
    store.setMaxTraces(Number.POSITIVE_INFINITY);

    await flushTraceCommits();

    expect(selectCommittedTraceNames(store)).toEqual(["three", "two"]);

    deactivate();
  });

  it("records successful and failed root trace lifecycles", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();

    const success = startRootTrace(
      createTraceFrameMeta("selector", "success", { id: "task-1" }),
      store,
    )!;
    endTraceSuccess(success);

    const failure = startRootTrace(
      createTraceFrameMeta("action", "failure", undefined),
      store,
    )!;
    endTraceError(failure, new Error("boom"));

    await flushTraceCommits();

    const [failedTrace, successTrace] = selectCommittedTraces(store);
    expect(successTrace?.status).toBe("success");
    expect(successTrace?.durationMs).toBeDefined();
    expect(failedTrace?.status).toBe("error");
    expect(failedTrace?.error?.message).toBe("boom");

    deactivate();
  });

  it("attaches nested frames under the active root", async () => {
    const store = new HyperDBTraceStore();
    const deactivate = store.activate();
    const rootMeta = createTraceFrameMeta("action", "root", undefined);
    const childMeta = createTraceFrameMeta("selector", "child", {
      id: "task-1",
    });
    const context = startRootTrace(rootMeta, store)!;

    enterFramePath(context, [rootMeta, childMeta]);
    endTraceSuccess(context);

    await flushTraceCommits();

    const trace = selectCommittedTraces(store)[0]!;
    expect(trace.frames[0]?.children).toHaveLength(1);
    expect(trace.frames[0]?.children[0]?.name).toBe("child");
    expect(trace.frames[0]?.children[0]?.arg).toEqual({ id: "task-1" });

    deactivate();
  });
});
