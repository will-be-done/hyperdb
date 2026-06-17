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
  action,
  asyncDispatch,
  deleteRows,
  getCurrentTraits,
  insert,
  syncDispatch,
  upsert,
} from "../commands/action/builders";
import { selectFrom } from "../commands/selector/builder";
import {
  createSelector,
  select,
  selector,
} from "../commands/selector/selector";
import { getTraceContextFromTraits } from "./context";
import { hyperDBTraceStore } from "./store";

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
    return yield* this.tx.intervalScan(table, indexName, clauses, selectOptions);
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

let unsubscribeTraceListener: (() => void) | undefined;

beforeEach(() => {
  unsubscribeTraceListener = hyperDBTraceStore.subscribe(() => {});
  hyperDBTraceStore.setMaxTraces(200);
  hyperDBTraceStore.clear();
});

afterEach(() => {
  hyperDBTraceStore.clear();
  unsubscribeTraceListener?.();
  unsubscribeTraceListener = undefined;
});

describe("devtool runtime tracing", () => {
  it("records one root action trace and a select event", () => {
    const db = createDB();
    execSync(db.insert(tasksTable, [task()]));

    const readTaskAction = action(function* readTask() {
      return yield* selectFrom(tasksTable, "projectState")
        .where((q) => q.eq("projectId", "project-1"))
        .limit(5)
        .order("asc");
    });

    const result = syncDispatch(db, readTaskAction());
    const trace = hyperDBTraceStore.getSnapshot()[0]!;

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

  it("records traces before the devtool opens when selector trace is enabled", () => {
    unsubscribeTraceListener?.();
    unsubscribeTraceListener = undefined;
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTable]));
    execSync(db.insert(tasksTable, [task()]));

    const tracedSelector = createSelector({ trace: true });
    const readTaskSelector = tracedSelector(function* readTaskBeforeDevtoolOpen() {
      return yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    expect(select(db, readTaskSelector())).toEqual([task()]);

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.name).toBe("readTaskBeforeDevtoolOpen");
    expect(trace.commandEvents).toHaveLength(1);
  });

  it("does not record devtool-open traces when selector auto trace is disabled", () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTable]));
    execSync(db.insert(tasksTable, [task()]));
    hyperDBTraceStore.clear();

    const manualOnlySelector = createSelector({ autoTrace: false });
    const readTaskSelector = manualOnlySelector(
      function* autoTraceDisabledSelector() {
        return yield* selectFrom(tasksTable, "projectState").where((q) =>
          q.eq("projectId", "project-1"),
        );
      },
    );

    expect(select(db, readTaskSelector())).toEqual([task()]);
    expect(hyperDBTraceStore.getSnapshot()).toEqual([]);
  });

  it("keeps the same db identity across traited wrappers", () => {
    const db = createDB();
    expect(db.withTraits({ type: "test.identity" }).getId()).toBe(db.getId());
    const readTaskAction = action(function* readTask() {
      return yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    syncDispatch(db, readTaskAction());
    syncDispatch(
      db.withTraits({
        type: "test.trait",
      }),
      readTaskAction(),
    );

    const dbIds = new Set(
      hyperDBTraceStore.getSnapshot().map((trace) => trace.dbId),
    );

    expect(dbIds.size).toBe(1);
  });

  it("records an action calling an action as one root with a child frame", () => {
    const db = createDB();

    const childTaskAction = action(function* childAction() {
      yield* insert(tasksTable, [task()]);
    });

    const parentTaskAction = action(function* parentAction() {
      yield* childTaskAction();
    });

    syncDispatch(db, parentTaskAction());

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.name).toBe("parentAction");
    expect(trace.frames[0]?.children).toHaveLength(1);
    expect(trace.frames[0]?.children[0]?.name).toBe("childAction");
    expect(trace.mutationEvents).toHaveLength(1);
    expect(trace.mutationEvents[0]?.frameId).toBe(
      trace.frames[0]?.children[0]?.id,
    );
  });

  it("records a selector calling a selector as one root with a child frame", () => {
    const db = createDB();
    execSync(db.insert(tasksTable, [task({ state: "done" })]));

    const allTasksSelector = selector(function* allTasks() {
      return yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    const doneTasksSelector = selector(function* doneTasks() {
      const rows = yield* allTasksSelector();
      return rows.filter((row) => row.state === "done");
    });

    expect(select(db, doneTasksSelector())).toEqual([task({ state: "done" })]);

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.kind).toBe("selector");
    expect(trace.name).toBe("doneTasks");
    expect(trace.frames[0]?.children[0]?.name).toBe("allTasks");
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.frameId).toBe(
      trace.frames[0]?.children[0]?.id,
    );
  });

  it("skips root and child traces for object selectors with skipTrace true", () => {
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
    expect(hyperDBTraceStore.getSnapshot()).toHaveLength(0);

    const parentSelector = selector(function* skippedTraceParentSelector() {
      return yield* skippedSelector({});
    });

    expect(select(db, parentSelector())).toEqual([task({ state: "done" })]);

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.name).toBe("skippedTraceParentSelector");
    expect(trace.frames[0]?.children).toHaveLength(0);
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.frameId).toBe(trace.frames[0]?.id);
  });

  it("records a non-generator selector success as a root trace", () => {
    const db = createDB();

    const plainSelector = selector(function plainValueSelector() {
      return "plain result";
    });

    expect(select(db, plainSelector())).toBe("plain result");

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.kind).toBe("selector");
    expect(trace.name).toBe("plainValueSelector");
    expect(trace.status).toBe("success");
    expect(trace.commandEvents).toHaveLength(0);
  });

  it("marks non-generator selector errors on the root trace, then rethrows", () => {
    const db = createDB();
    const failingSelector = selector(function failingPlainSelector() {
      throw new Error("plain selector failed");
    });

    expect(() => select(db, failingSelector())).toThrow(
      "plain selector failed",
    );

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.kind).toBe("selector");
    expect(trace.name).toBe("failingPlainSelector");
    expect(trace.status).toBe("error");
    expect(trace.error?.message).toBe("plain selector failed");
    expect(trace.commandEvents).toHaveLength(0);
  });

  it("marks select errors on the command and root trace, then rethrows", () => {
    const db = new DB(new BptreeInmemDriver());
    const failingSelector = selector(function* failingSelector() {
      return yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    expect(() => select(db, failingSelector())).toThrow();

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    expect(trace.status).toBe("error");
    expect(trace.error?.message).toBeTruthy();
    expect(trace.commandEvents).toHaveLength(1);
    expect(trace.commandEvents[0]?.status).toBe("error");
    expect(trace.commandEvents[0]?.error?.message).toBeTruthy();
  });

  it("records insert, upsert, and delete payloads through SubscribableDBTx", () => {
    const db = createDB();
    const updatedTask = task({ title: "Updated", state: "done" });

    const mutateTasks = action(function* mutateTasks() {
      yield* insert(tasksTable, [task()]);
      yield* upsert(tasksTable, [updatedTask]);
      yield* deleteRows(tasksTable, [updatedTask.id]);
    });

    syncDispatch(db, mutateTasks());

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
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

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
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
      observedSubscriberTraces.push(getTraceContextFromTraits(traits)?.trace.name);
    });

    const readTraceTraitsAction = action(function* traceTraitsAction() {
      const traits = yield* getCurrentTraits();
      yield* insert(tasksTable, [task()]);

      return getTraceContextFromTraits(traits)?.trace.name;
    });

    expect(syncDispatch(db, readTraceTraitsAction())).toBe("traceTraitsAction");
    expect(observedSubscriberTraces).toEqual(["traceTraitsAction"]);
  });

  it("does not create extra roots for synchronous afterChange subscribers", () => {
    const db = createDB();
    db.afterChange(function* afterChange() {
      yield* selectFrom(tasksTable, "projectState").where((q) =>
        q.eq("projectId", "project-1"),
      );
    });

    const mutateTasks = action(function* mutateTasks() {
      yield* insert(tasksTable, [task()]);
    });

    syncDispatch(db, mutateTasks());

    const traces = hyperDBTraceStore.getSnapshot();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.commandEvents).toHaveLength(1);
    expect(traces[0]?.mutationEvents).toHaveLength(1);
  });
});
