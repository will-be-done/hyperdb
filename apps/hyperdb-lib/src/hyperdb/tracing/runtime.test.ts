import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB, execAsync, execSync } from "../db";
import { unwrap } from "../commands/async";
import type { DBDriver, DBDriverTX } from "../core/driver";
import type { Row, SelectOptions, WhereClause } from "../core/primitives";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { SubscribableDB } from "../runtime/subscribable-db";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import {
  asyncDispatch,
  createAction,
  deleteRows,
  getCurrentTraits,
  insert,
  syncDispatch,
  upsert,
} from "../commands/action/builders";
import { selectFrom } from "../commands/selector/builder";
import { createSelector, select } from "../commands/selector/selector";
import { getTraceContextFromTraits } from "./context";
import {
  hyperDBTraceStore,
  traceRootsRuntimeTable,
  unassignedTraceDBKey,
  type RootTrace,
  type TraceFrame,
} from "./store";
import { flushTraceCommits } from "./test-utils";

type Task = {
  id: string;
  title: string;
  state: "todo" | "done";
  projectId: string;
};

class FakeAsyncDriverTx implements DBDriverTX {
  constructor(private readonly tx: DBDriverTX) {}

  *commit() {
    yield* unwrap(Promise.resolve());
    yield* this.tx.commit();
  }

  *rollback() {
    yield* unwrap(Promise.resolve());
    yield* this.tx.rollback();
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ) {
    yield* unwrap(Promise.resolve());
    return yield* this.tx.intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }

  *insert(tableName: string, values: Row[]) {
    yield* unwrap(Promise.resolve());
    yield* this.tx.insert(tableName, values);
  }

  *upsert(tableName: string, values: Row[]) {
    yield* unwrap(Promise.resolve());
    yield* this.tx.upsert(tableName, values);
  }

  *delete(tableName: string, values: string[]) {
    yield* unwrap(Promise.resolve());
    yield* this.tx.delete(tableName, values);
  }
}

class FakeAsyncDriver implements DBDriver {
  private readonly driver = new BptreeInmemDriver();

  *loadTables(tables: Parameters<DBDriver["loadTables"]>[0]) {
    yield* unwrap(Promise.resolve());
    yield* this.driver.loadTables(tables);
  }

  *beginTx() {
    yield* unwrap(Promise.resolve());
    return new FakeAsyncDriverTx(yield* this.driver.beginTx());
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ) {
    yield* unwrap(Promise.resolve());
    return yield* this.driver.intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }

  *insert(tableName: string, values: Row[]) {
    yield* unwrap(Promise.resolve());
    yield* this.driver.insert(tableName, values);
  }

  *upsert(tableName: string, values: Row[]) {
    yield* unwrap(Promise.resolve());
    yield* this.driver.upsert(tableName, values);
  }

  *delete(tableName: string, values: string[]) {
    yield* unwrap(Promise.resolve());
    yield* this.driver.delete(tableName, values);
  }
}

const tasksTable = defineTable("devtoolTasks", {
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  projectId: v.string(),
}).index("projectState", ["projectId", "state"]);

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Task 1",
  state: "todo",
  projectId: "project-1",
  ...overrides,
});

const createDB = (): SubscribableDB => {
  const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables([tasksTable]));
  return db;
};

const createAsyncDB = async (): Promise<DB> => {
  const db = new DB(new FakeAsyncDriver());
  await execAsync(db.loadTables([tasksTable]));
  return db;
};

const trace = (overrides: Partial<RootTrace>): RootTrace => ({
  id: overrides.id ?? "trace-1",
  kind: overrides.kind ?? "selector",
  name: overrides.name ?? "trace",
  arg: undefined,
  startedAt: overrides.startedAt ?? 0,
  durationMs: overrides.durationMs,
  status: overrides.status ?? "success",
  frames: [],
  commandEvents: [],
  mutationEvents: [],
  ...overrides,
});

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

let deactivateTraceStore: (() => void) | undefined;

beforeEach(() => {
  deactivateTraceStore = hyperDBTraceStore.activate();
  hyperDBTraceStore.setMaxTraces(200);
  hyperDBTraceStore.clear();
});

afterEach(() => {
  hyperDBTraceStore.clear();
  deactivateTraceStore?.();
  deactivateTraceStore = undefined;
});

const action = createAction();
const selector = createSelector();

const selectCommittedTraces = (limit = 20): RootTrace[] =>
  select(
    hyperDBTraceStore.getDB(),
    (function* () {
      const rows = yield* selectFrom(traceRootsRuntimeTable, "byCreatedSeq")
        .order("desc")
        .limit(limit);
      return hyperDBTraceStore.resolveTraceRows(rows);
    })(),
  );

describe("devtool runtime tracing", () => {
  it("records one root action trace and a select event", async () => {
    const db = createDB();
    execSync(db.insert(tasksTable, [task()]));

    const readTaskAction = action({
      name: "readTask",
      args: {},
      handler: function* readTask() {
        return yield* selectFrom(tasksTable, "projectState")
          .where((q) => q.eq("projectId", "project-1"))
          .limit(5)
          .order("asc");
      },
    });

    const result = syncDispatch(db, readTaskAction({}));
    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;

    expect(result).toEqual([task()]);
    expect(trace.kind).toBe("action");
    expect(trace.name).toBe("readTask");
    expect(trace.dbId).toBeDefined();
    expect(trace.dbLabel).toMatch(/^DB \d+$/);
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.mutationEvents).toHaveLength(0);
    expect(trace.commandEvents[0]).toMatchObject({
      tableName: "devtoolTasks",
      index: "projectState",
      limit: 5,
      order: "asc",
      resultCount: 1,
      result: [task()],
      status: "success",
    });
    expect(trace.commandEvents[0]?.where[0]?.eq).toEqual([
      { col: "projectId", val: "project-1" },
    ]);
    expect(trace.commandEvents[0]?.bounds.length).toBeGreaterThan(0);
  });

  it("records traces before the devtool opens when selector trace is enabled", async () => {
    deactivateTraceStore?.();
    deactivateTraceStore = undefined;
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTable]));
    execSync(db.insert(tasksTable, [task()]));

    const tracedSelector = createSelector({
      trace: { enabled: true, startOn: "load" },
    });
    const readTaskSelector = tracedSelector({
      name: "readTaskBeforeDevtoolOpen",
      args: {},
      handler: function* readTaskBeforeDevtoolOpen() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    expect(select(db, readTaskSelector({}))).toEqual([task()]);

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.name).toBe("readTaskBeforeDevtoolOpen");
    expect(trace.commandEvents).toHaveLength(1);
  });

  it("does not record traces when selector tracing is disabled", () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTable]));
    execSync(db.insert(tasksTable, [task()]));
    hyperDBTraceStore.clear();

    const tracingDisabledSelector = createSelector({
      trace: { enabled: false, startOn: "devtoolOpen" },
    });
    const readTaskSelector = tracingDisabledSelector({
      name: "tracingDisabledSelector",
      args: {},
      handler: function* tracingDisabledSelector() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    expect(select(db, readTaskSelector({}))).toEqual([task()]);
    expect(selectCommittedTraces()).toEqual([]);
  });

  it("returns traces ordered by duration through HyperDB indexes", () => {
    hyperDBTraceStore.addTrace(
      trace({ id: "slow", name: "slow", durationMs: 30, kind: "selector" }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "fast", name: "fast", durationMs: 5, kind: "selector" }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "action", name: "action", durationMs: 20, kind: "action" }),
    );
    hyperDBTraceStore.addTrace(
      trace({ id: "running", name: "running", kind: "selector" }),
    );

    expect(
      select(
        hyperDBTraceStore.getDB(),
        (function* () {
          const rows = yield* selectFrom(traceRootsRuntimeTable, "byDurationMs")
            .order("desc")
            .limit(10);
          return hyperDBTraceStore.resolveTraceRows(rows);
        })(),
      ).map((item) => item.name),
    ).toEqual(["slow", "action", "fast", "running"]);
    expect(
      select(
        hyperDBTraceStore.getDB(),
        (function* () {
          const rows = yield* selectFrom(traceRootsRuntimeTable, "byDurationMs")
            .order("asc")
            .limit(10);
          return hyperDBTraceStore
            .resolveTraceRows(rows)
            .filter((item) => item.kind === "selector");
        })(),
      ).map((item) => item.name),
    ).toEqual(["running", "fast", "slow"]);
  });

  it("filters traces by DB through HyperDB indexes and cached state in memory", () => {
    hyperDBTraceStore.addTrace(
      trace({
        id: "db-a-visible",
        name: "db-a-visible",
        dbId: "db-a",
        durationMs: 10,
        frames: [traceFrame()],
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "db-a-cached",
        name: "db-a-cached",
        dbId: "db-a",
        durationMs: 5,
        frames: [traceFrame(true)],
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "db-b-visible",
        name: "db-b-visible",
        dbId: "db-b",
        durationMs: 1,
        frames: [traceFrame()],
      }),
    );
    hyperDBTraceStore.addTrace(
      trace({
        id: "unassigned",
        name: "unassigned",
        durationMs: 20,
        frames: [traceFrame()],
      }),
    );

    expect(
      select(
        hyperDBTraceStore.getDB(),
        (function* () {
          const rows = yield* selectFrom(traceRootsRuntimeTable, "byDbDurationMs")
            .where((q) => q.eq("dbKey", "db-a"))
            .order("asc")
            .limit(10);
          return hyperDBTraceStore
            .resolveTraceRows(rows)
            .filter((item) => item.frames[0]?.cached !== true);
        })(),
      ).map((item) => item.name),
    ).toEqual(["db-a-visible"]);
    expect(
      select(
        hyperDBTraceStore.getDB(),
        (function* () {
          const rows = yield* selectFrom(traceRootsRuntimeTable, "byDbStartedAt")
            .where((q) => q.eq("dbKey", unassignedTraceDBKey))
            .order("desc")
            .limit(10);
          return hyperDBTraceStore.resolveTraceRows(rows);
        })(),
      ).map((item) => item.name),
    ).toEqual(["unassigned"]);
  });

  it("keeps the same db identity across traited wrappers", async () => {
    const db = createDB();
    expect(db.withTraits({ type: "test.identity" }).getId()).toBe(db.getId());
    const readTaskAction = action({
      name: "readTask",
      args: {},
      handler: function* readTask() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    syncDispatch(db, readTaskAction({}));
    syncDispatch(
      db.withTraits({
        type: "test.trait",
      }),
      readTaskAction({}),
    );

    await flushTraceCommits();

    const dbIds = new Set(selectCommittedTraces().map((trace) => trace.dbId));

    expect(dbIds.size).toBe(1);
  });

  it("records an action calling an action as one root with a child frame", async () => {
    const db = createDB();

    const childTaskAction = action({
      name: "childAction",
      args: {},
      handler: function* childAction() {
        yield* insert(tasksTable, [task()]);
      },
    });

    const parentTaskAction = action({
      name: "parentAction",
      args: {},
      handler: function* parentAction() {
        yield* childTaskAction({});
      },
    });

    syncDispatch(db, parentTaskAction({}));

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.name).toBe("parentAction");
    expect(trace.frames[0]?.children).toHaveLength(1);
    expect(trace.frames[0]?.children[0]?.name).toBe("childAction");
    expect(trace.mutationEvents).toHaveLength(1);
    expect(trace.mutationEvents[0]?.frameId).toBe(
      trace.frames[0]?.children[0]?.id,
    );
  });

  it("records a selector calling a selector as one root with a child frame", async () => {
    const db = createDB();
    execSync(db.insert(tasksTable, [task({ state: "done" })]));

    const allTasksSelector = selector({
      name: "allTasks",
      args: {},
      handler: function* allTasks() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    const doneTasksSelector = selector({
      name: "doneTasks",
      args: {},
      handler: function* doneTasks() {
        const rows = yield* allTasksSelector({});
        return rows.filter((row) => row.state === "done");
      },
    });

    expect(select(db, doneTasksSelector({}))).toEqual([
      task({ state: "done" }),
    ]);

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.kind).toBe("selector");
    expect(trace.name).toBe("doneTasks");
    expect(trace.frames[0]?.children[0]?.name).toBe("allTasks");
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.frameId).toBe(
      trace.frames[0]?.children[0]?.id,
    );
  });

  it("skips root and child traces for object selectors with skipTrace true", async () => {
    const db = createDB();
    execSync(db.insert(tasksTable, [task({ state: "done" })]));

    const childSelector = selector({
      name: "childOfSkippedSelector",
      args: {},
      handler: function* childOfSkippedSelector() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    const skippedSelector = selector({
      name: "skippedSelector",
      args: {},
      skipTrace: true,
      handler: function* skippedSelector() {
        return yield* childSelector({});
      },
    });

    expect(select(db, skippedSelector({}))).toEqual([task({ state: "done" })]);
    expect(selectCommittedTraces()).toHaveLength(0);

    const parentSelector = selector({
      name: "skippedTraceParentSelector",
      args: {},
      handler: function* skippedTraceParentSelector() {
        return yield* skippedSelector({});
      },
    });

    expect(select(db, parentSelector({}))).toEqual([task({ state: "done" })]);

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.name).toBe("skippedTraceParentSelector");
    expect(trace.frames[0]?.children).toHaveLength(0);
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.frameId).toBe(trace.frames[0]?.id);
  });

  it("marks select errors on the command and root trace, then rethrows", async () => {
    const db = new DB(new BptreeInmemDriver());
    const failingSelector = selector({
      name: "failingSelector",
      args: {},
      handler: function* failingSelector() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    expect(() => select(db, failingSelector({}))).toThrow();

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.status).toBe("error");
    expect(trace.error?.message).toBeTruthy();
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.status).toBe("error");
    expect(trace.commandEvents[0]?.error?.message).toBeTruthy();
  });

  it("records insert, upsert, and delete payloads through SubscribableDBTx", async () => {
    const db = createDB();
    const updatedTask = task({ title: "Updated", state: "done" });

    const mutateTasks = action({
      name: "mutateTasks",
      args: {},
      handler: function* mutateTasks() {
        yield* insert(tasksTable, [task()]);
        yield* upsert(tasksTable, [updatedTask]);
        yield* deleteRows(tasksTable, [updatedTask.id]);
      },
    });

    syncDispatch(db, mutateTasks({}));

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.mutationEvents.map((event) => event.kind)).toEqual([
      "insert",
      "upsert",
      "delete",
    ]);
    expect(trace.mutationEvents[0]?.newValue).toEqual([task()]);
    expect(trace.mutationEvents[1]?.oldValue).toEqual([task()]);
    expect(trace.mutationEvents[1]?.newValue).toEqual([updatedTask]);
    expect(trace.mutationEvents[2]?.ids).toEqual([updatedTask.id]);
    expect(trace.mutationEvents[2]?.oldValue).toEqual([updatedTask]);
  });

  it("records mutations from async plain DB transactions", async () => {
    const db = await createAsyncDB();
    const updatedTask = task({ title: "Updated async" });

    const readTaskSelector = selector({
      name: "readTaskBeforeAsyncMutation",
      args: {},
      handler: function* readTaskBeforeAsyncMutation() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    });

    const mutateAfterSelect = action({
      name: "mutateAfterSelect",
      args: {},
      handler: function* mutateAfterSelect() {
        yield* readTaskSelector({});
        yield* upsert(tasksTable, [updatedTask]);
      },
    });

    await asyncDispatch(db, mutateAfterSelect({}));

    await flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.name).toBe("mutateAfterSelect");
    expect(trace.frames[0]?.children[0]?.name).toBe(
      "readTaskBeforeAsyncMutation",
    );
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.mutationEvents).toHaveLength(1);
    expect(trace.mutationEvents[0]).toMatchObject({
      kind: "upsert",
      tableName: "devtoolTasks",
      newValue: [updatedTask],
      rows: [updatedTask],
      status: "success",
    });
  });

  it("passes the trace context through traits", () => {
    const db = createDB();
    const observedSubscriberTraces: (string | undefined)[] = [];

    db.afterChange(function* afterChange(_db, _table, traits) {
      observedSubscriberTraces.push(
        getTraceContextFromTraits(traits)?.trace.name,
      );
    });

    const readTraceTraitsAction = action({
      name: "traceTraitsAction",
      args: {},
      handler: function* traceTraitsAction() {
        const traits = yield* getCurrentTraits();
        yield* insert(tasksTable, [task()]);

        return getTraceContextFromTraits(traits)?.trace.name;
      },
    });

    expect(syncDispatch(db, readTraceTraitsAction({}))).toBe(
      "traceTraitsAction",
    );
    expect(observedSubscriberTraces).toEqual(["traceTraitsAction"]);
  });

  it("does not create extra roots for synchronous afterChange subscribers", async () => {
    const db = createDB();
    db.afterChange(function* afterChange() {
      yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    const mutateTasks = action({
      name: "mutateTasks",
      args: {},
      handler: function* mutateTasks() {
        yield* insert(tasksTable, [task()]);
      },
    });

    syncDispatch(db, mutateTasks({}));

    await flushTraceCommits();
    const traces = selectCommittedTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.commandEvents).toHaveLength(1);
    expect(traces[0]?.mutationEvents).toHaveLength(1);
  });
});
