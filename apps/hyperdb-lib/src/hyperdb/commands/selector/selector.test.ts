import { afterEach, describe, expect, test, vi } from "vitest";
import { DB, execSync } from "../../db";
import {
  createSelector,
  initSelector,
  initCachedSelector,
  select,
} from "./selector";
import { SubscribableDB } from "../../runtime/subscribable-db";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../../schema/table";
import { selectFrom } from "./builder";
import { v } from "../../schema/values";
import { getGeneratorTraceMeta } from "../../tracing/metadata";
import {
  hyperDBTraceStore,
  traceRootsRuntimeTable,
  type RootTrace,
  type TraceFrame,
} from "../../tracing/store";

type Task = {
  type: "task";
  id: string;
  title: string;
  state: "todo" | "done";
  projectId: string;
  orderToken: string;
};
const selector = createSelector();

const flushTraceCommits = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 120);
  });
};

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

const tasksTable = defineTable("tasks", {
  type: v.literal("task"),
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  projectId: v.string(),
  orderToken: v.string(),
}).index("projectIdState", ["projectId", "state"]);

const driver = new BptreeInmemDriver();
const db = new SubscribableDB(new DB(driver));
execSync(db.loadTables([tasksTable]));

const allTasks = selector({
  name: "allTasks",
  args: {},
  handler: function* allTasks() {
    const tasks = yield* selectFrom(tasksTable, "projectIdState").where((q) =>
      q.eq("projectId", "1"),
    );

    return tasks;
  },
});

const justSelector = selector({
  name: "justSelector",
  args: {},
  handler: function* justSelector() {
    return "just selector";
  },
});

const allDoneTasks = selector({
  name: "allDoneTasks",
  args: { state: v.union(v.literal("todo"), v.literal("done")) },
  handler: function* allDoneTasks({ state }) {
    const tasks = yield* allTasks({});

    console.log("justSelector", yield* justSelector({}));

    return tasks.filter((task) => task.state === state);
  },
});

const specificTask = selector({
  name: "specificTask",
  args: { id: v.string() },
  handler: function* specificTask({ id }) {
    const tasks = yield* selectFrom(tasksTable, "byId").where((q) =>
      q.eq("id", id),
    );
    return tasks[0];
  },
});

const createTestDB = (
  ...tables: Parameters<SubscribableDB["loadTables"]>[0]
) => {
  const testDb = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(testDb.loadTables(tables));
  return testDb;
};

const makeGroupRows = (
  group: string,
  count: number,
  prefix = group,
): { id: string; group: string; orderToken: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    group,
    orderToken: String(index).padStart(3, "0"),
  }));

afterEach(() => {
  vi.useRealTimers();
});

describe("selector", () => {
  test("object-form selector returns rows and can yield another selector", () => {
    const objectTasksTable = defineTable("objectSelectorTasks", {
      id: v.string(),
      title: v.string(),
      state: v.union(v.literal("todo"), v.literal("done")),
      projectId: v.string(),
    }).index("projectState", ["projectId", "state"]);
    const testDb = createTestDB(objectTasksTable);

    execSync(
      testDb.insert(objectTasksTable, [
        {
          id: "task-1",
          title: "Task 1",
          state: "done",
          projectId: "project-1",
        },
        {
          id: "task-2",
          title: "Task 2",
          state: "todo",
          projectId: "project-1",
        },
      ]),
    );

    const projectTasks = selector({
      name: "projectTasks",
      args: { projectId: v.string() },
      handler: function* ({ projectId }) {
        return yield* selectFrom(objectTasksTable, "projectState").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });

    const doneProjectTasks = selector({
      name: "doneProjectTasks",
      args: { projectId: v.string() },
      handler: function* doneProjectTasks({ projectId }) {
        const tasks = yield* projectTasks({ projectId });
        return tasks.filter((task) => task.state === "done");
      },
    });

    expect(
      select(testDb, doneProjectTasks({ projectId: "project-1" })),
    ).toEqual([
      {
        id: "task-1",
        title: "Task 1",
        state: "done",
        projectId: "project-1",
      },
    ]);
  });

  test("object-form selector exposes metadata and traces the args object", () => {
    const args = { id: v.string() };
    const metadataSelector = selector({
      name: "metadataSelector",
      args,
      skipTrace: { childTrace: true, rootTrace: false },
      handler: function* ({ id }) {
        return id;
      },
    });

    const gen = metadataSelector({ id: "task-1" });
    const traceMeta = getGeneratorTraceMeta(gen);

    expect(metadataSelector.kind).toBe("selector");
    expect(metadataSelector.name).toBe("metadataSelector");
    expect(metadataSelector.args).toBe(args);
    expect(metadataSelector.skipTrace).toEqual({
      childTrace: true,
      rootTrace: false,
    });
    expect(metadataSelector.trace).toEqual({
      enabled: true,
      startOn: "devtoolOpen",
    });
    expect(metadataSelector.validateArgs).toBe(false);
    expect(traceMeta?.name).toBe("metadataSelector");
    expect(traceMeta?.arg).toEqual({ id: "task-1" });
    expect(traceMeta?.skipChildTrace).toBe(true);
    expect(traceMeta?.skipRootTrace).toBe(false);
  });

  test("object-form selector requires an explicit name", () => {
    expect(() =>
      selector({
        args: {},
        handler: function* missingSelectorName() {
          return null;
        },
      } as never),
    ).toThrow("Selector name is required");

    expect(() =>
      selector({
        name: "",
        args: {},
        handler: function* blankSelectorName() {
          return null;
        },
      }),
    ).toThrow("Selector name is required");
  });

  test("createSelector can enable and disable object args validation", () => {
    const validatingSelector = createSelector({ validateArgs: true });
    const looseSelector = createSelector({ validateArgs: false });

    const validated = validatingSelector({
      name: "validatedArgsSelector",
      args: { id: v.string() },
      handler: function* ({ id }) {
        return id;
      },
    });
    const loose = looseSelector({
      name: "looseArgsSelector",
      args: { id: v.string() },
      handler: function* ({ id }) {
        return id;
      },
    });

    expect(validated.validateArgs).toBe(true);
    expect(() => validated({ id: 123 } as never)).toThrow(
      "expected string at id",
    );
    expect(() => validated({ id: "task-1" })).not.toThrow();
    expect(() => loose({ id: 123 } as never)).not.toThrow();
  });

  test("selector builder configure updates existing selectors", () => {
    const configurableSelector = createSelector({
      trace: { enabled: true, startOn: "devtoolOpen" },
      validateArgs: false,
    });

    const configured = configurableSelector({
      name: "configuredSelector",
      args: { id: v.string() },
      handler: function* ({ id }) {
        return id;
      },
    });

    configurableSelector.configure({
      trace: { startOn: "load" },
      validateArgs: true,
    });

    const gen = configured({ id: "task-1" });
    const traceMeta = getGeneratorTraceMeta(gen);

    expect(configured.trace).toEqual({ enabled: true, startOn: "load" });
    expect(configured.validateArgs).toBe(true);
    expect(traceMeta?.trace).toEqual({ enabled: true, startOn: "load" });
    expect(() => configured({ id: 123 } as never)).toThrow(
      "expected string at id",
    );
  });

  test("cached object-form selectors share one DB subscription for same args", () => {
    const cachedTasksTable = defineTable("cachedSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = createTestDB(cachedTasksTable);
    let runCount = 0;

    const cachedTasks = selector({
      name: "cachedTasks",
      args: { projectId: v.string() },
      handler: function* cachedTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(cachedTasksTable, "project").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });

    const first = initCachedSelector(testDb, cachedTasks, {
      projectId: "project-1",
    });
    const second = initCachedSelector(testDb, cachedTasks, {
      projectId: "project-1",
    });
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});

    expect(runCount).toBe(1);
    expect(testDb.subscribers).toHaveLength(1);

    unsubscribeFirst();
    expect(testDb.subscribers).toHaveLength(1);

    unsubscribeSecond();
    expect(testDb.subscribers).toHaveLength(0);
  });

  test("cached object-form selector freezes args when enabled", () => {
    const freezeArgsTasksTable = defineTable("freezeArgsTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = new SubscribableDB(
      new DB(new BptreeInmemDriver(), { freezeArgs: true }),
    );
    execSync(testDb.loadTables([freezeArgsTasksTable]));

    const args = {
      filter: {
        projectId: "project-1",
      },
    };
    const freezeArgsTasks = selector({
      name: "freezeArgsTasks",
      args: { filter: v.object({ projectId: v.string() }) },
      handler: function* freezeArgsTasks({ filter }) {
        return yield* selectFrom(freezeArgsTasksTable, "project").where((q) =>
          q.eq("projectId", filter.projectId),
        );
      },
    });

    initCachedSelector(testDb, freezeArgsTasks, args);

    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args.filter)).toBe(true);
    expect(() => {
      args.filter.projectId = "project-2";
    }).toThrow(TypeError);
  });

  test("cached object-form selector args normalize nested object key order", () => {
    const orderedTasksTable = defineTable("orderedSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
      orderToken: v.string(),
    }).index("projectOrder", ["projectId", "orderToken"]);
    const testDb = createTestDB(orderedTasksTable);
    let runCount = 0;

    const orderedTasks = selector({
      name: "orderedTasks",
      args: {
        filter: v.object({
          projectId: v.string(),
          orderToken: v.string(),
        }),
      },
      handler: function* orderedTasks({ filter }) {
        runCount++;
        return yield* selectFrom(orderedTasksTable, "projectOrder").where((q) =>
          q
            .eq("projectId", filter.projectId)
            .eq("orderToken", filter.orderToken),
        );
      },
    });

    const first = initCachedSelector(testDb, orderedTasks, {
      filter: { projectId: "project-1", orderToken: "a" },
    });
    const second = initCachedSelector(testDb, orderedTasks, {
      filter: { orderToken: "a", projectId: "project-1" },
    });
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});

    expect(runCount).toBe(1);
    expect(testDb.subscribers).toHaveLength(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("cached object-form selector args distinguish negative zero", () => {
    const testDb = createTestDB();
    let runCount = 0;

    const signedZero = selector({
      name: "signedZeroSelector",
      args: { value: v.number() },
      handler: function* signedZeroSelector({ value }) {
        runCount++;
        return Object.is(value, -0) ? "negative zero" : "positive zero";
      },
    });

    const negative = initCachedSelector(testDb, signedZero, { value: -0 });
    const positive = initCachedSelector(testDb, signedZero, { value: 0 });

    expect(negative.getSnapshot()).toBe("negative zero");
    expect(positive.getSnapshot()).toBe("positive zero");
    expect(runCount).toBe(2);
  });

  test("cached object-form selector args support ArrayBuffer values", () => {
    const testDb = createTestDB();
    let runCount = 0;
    const buffer = (...bytes: number[]) =>
      new Uint8Array(bytes).buffer as ArrayBuffer;

    const binarySelector = selector({
      name: "binaryArgSelector",
      args: { bytes: v.arrayBuffer() },
      handler: function* binaryArgSelector({ bytes }) {
        runCount++;
        return Array.from(new Uint8Array(bytes)).join(",");
      },
    });

    const first = initCachedSelector(testDb, binarySelector, {
      bytes: buffer(1, 2),
    });
    const equivalent = initCachedSelector(testDb, binarySelector, {
      bytes: buffer(1, 2),
    });
    const different = initCachedSelector(testDb, binarySelector, {
      bytes: buffer(2, 1),
    });

    expect(first.getSnapshot()).toBe("1,2");
    expect(equivalent.getSnapshot()).toBe("1,2");
    expect(different.getSnapshot()).toBe("2,1");
    expect(runCount).toBe(2);
  });

  test("cached object-form selector rejects unsupported serialized args", () => {
    const rejectedArgsTasksTable = defineTable("rejectedArgsSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = createTestDB(rejectedArgsTasksTable);
    const rejectedArgsTasks = selector({
      name: "rejectedArgsTasks",
      args: { projectId: v.string() },
      handler: function* rejectedArgsTasks({ projectId }) {
        return yield* selectFrom(rejectedArgsTasksTable, "project").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const arrayWithProp = ["project-1"] as string[] & { extra?: string };
    arrayWithProp.extra = "value";

    expect(() =>
      initCachedSelector(testDb, rejectedArgsTasks, {
        projectId: undefined,
      } as never),
    ).toThrow(/undefined is not supported/);
    expect(() =>
      initCachedSelector(testDb, rejectedArgsTasks, {
        projectId: () => "project-1",
      } as never),
    ).toThrow(/functions are not supported/);
    expect(() =>
      initCachedSelector(testDb, rejectedArgsTasks, circular as never),
    ).toThrow(/circular reference/);
    expect(() =>
      initCachedSelector(testDb, rejectedArgsTasks, {
        projectId: arrayWithProp,
      } as never),
    ).toThrow(/array properties are not supported/);
    expect(testDb.subscribers).toHaveLength(0);
  });

  test("object-form selector can disable root memoization", () => {
    const testDb = createTestDB();
    let getterReads = 0;
    let runs = 0;
    const args = {};
    Object.defineProperty(args, "value", {
      enumerable: true,
      get() {
        getterReads++;
        return "expensive";
      },
    });

    const uncachedSelector = selector({
      name: "uncachedRootSelector",
      args: { value: v.any() },
      memoization: { root: false },
      handler: function* uncachedRootSelector() {
        runs++;
        return runs;
      },
    });

    const first = initCachedSelector(testDb, uncachedSelector, args as never);
    const second = initCachedSelector(testDb, uncachedSelector, args as never);

    expect(first.getSnapshot()).toBe(1);
    expect(second.getSnapshot()).toBe(2);
    expect(getterReads).toBe(0);
  });

  test("cached object-form selectors split entries by args", () => {
    const cachedArgsTasksTable = defineTable("cachedArgsSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = createTestDB(cachedArgsTasksTable);

    const cachedTasks = selector({
      name: "cachedArgsTasks",
      args: { projectId: v.string() },
      handler: function* cachedTasks({ projectId }) {
        return yield* selectFrom(cachedArgsTasksTable, "project").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });

    const first = initCachedSelector(testDb, cachedTasks, {
      projectId: "project-1",
    });
    const second = initCachedSelector(testDb, cachedTasks, {
      projectId: "project-2",
    });
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});

    expect(testDb.subscribers).toHaveLength(2);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("cached object-form selector reruns only for invalidating ops", () => {
    const invalidationTasksTable = defineTable("invalidationSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
      orderToken: v.string(),
    }).index("projectOrder", ["projectId", "orderToken"]);
    const testDb = createTestDB(invalidationTasksTable);
    const snapshots: string[][] = [];
    let runCount = 0;

    const projectTasks = selector({
      name: "invalidationProjectTasks",
      args: { projectId: v.string() },
      handler: function* projectTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(invalidationTasksTable, "projectOrder").where(
          (q) => q.eq("projectId", projectId),
        );
      },
    });

    const cached = initCachedSelector(testDb, projectTasks, {
      projectId: "project-1",
    });
    const unsubscribe = cached.subscribe(() => {
      snapshots.push(cached.getSnapshot().map((task) => task.id));
    });

    execSync(
      testDb.insert(invalidationTasksTable, [
        { id: "other", projectId: "project-2", orderToken: "a" },
      ]),
    );

    expect(runCount).toBe(1);
    expect(snapshots).toEqual([]);

    execSync(
      testDb.insert(invalidationTasksTable, [
        { id: "matching", projectId: "project-1", orderToken: "a" },
      ]),
    );

    expect(runCount).toBe(2);
    expect(snapshots).toEqual([["matching"]]);

    unsubscribe();
  });

  test("cached object-form selector reuse is recorded as cached in the trace", async () => {
    const deactivateTrace = hyperDBTraceStore.activate();
    hyperDBTraceStore.clear();

    try {
      const cachedTraceTasksTable = defineTable("cachedTraceTasks", {
        id: v.string(),
        projectId: v.string(),
      }).index("project", ["projectId"]);
      const testDb = createTestDB(cachedTraceTasksTable);
      let runCount = 0;

      const cachedTasks = selector({
        name: "cachedTraceSelector",
        args: { projectId: v.string() },
        handler: function* cachedTraceSelector({ projectId }) {
          runCount++;
          return yield* selectFrom(cachedTraceTasksTable, "project").where(
            (q) => q.eq("projectId", projectId),
          );
        },
      });

      initCachedSelector(testDb, cachedTasks, { projectId: "project-1" });
      hyperDBTraceStore.clear();

      initCachedSelector(testDb, cachedTasks, { projectId: "project-1" });

      expect(runCount).toBe(1);
      await flushTraceCommits();
      const trace = selectCommittedTraces()[0]!;
      expect(trace.name).toBe("cachedTraceSelector");
      expect(trace.commandEvents).toHaveLength(0);
      expect(trace.frames[0]?.cached).toBe(true);
    } finally {
      deactivateTrace();
      hyperDBTraceStore.clear();
    }
  });

  test("cached object-form selector range misses are recorded as cached in the trace", async () => {
    const deactivateTrace = hyperDBTraceStore.activate();
    let unsubscribeSelector: (() => void) | undefined;
    hyperDBTraceStore.clear();

    try {
      const rangeMissTraceTasksTable = defineTable("rangeMissTraceTasks", {
        id: v.string(),
        projectId: v.string(),
        orderToken: v.string(),
      }).index("projectOrder", ["projectId", "orderToken"]);
      const testDb = createTestDB(rangeMissTraceTasksTable);
      let runCount = 0;

      const projectTasks = selector({
        name: "rangeMissTraceSelector",
        args: { projectId: v.string() },
        handler: function* rangeMissTraceSelector({ projectId }) {
          runCount++;
          return yield* selectFrom(
            rangeMissTraceTasksTable,
            "projectOrder",
          ).where((q) => q.eq("projectId", projectId));
        },
      });

      const cached = initCachedSelector(testDb, projectTasks, {
        projectId: "project-1",
      });
      unsubscribeSelector = cached.subscribe(() => {});
      hyperDBTraceStore.clear();

      execSync(
        testDb.insert(rangeMissTraceTasksTable, [
          { id: "other", projectId: "project-2", orderToken: "a" },
        ]),
      );

      expect(runCount).toBe(1);
      await flushTraceCommits();
      const trace = selectCommittedTraces()[0]!;
      expect(trace.name).toBe("rangeMissTraceSelector");
      expect(trace.commandEvents).toHaveLength(0);
      expect(trace.frames[0]?.cached).toBe(true);
    } finally {
      unsubscribeSelector?.();
      deactivateTrace();
      hyperDBTraceStore.clear();
    }
  });

  test("cached object-form selector keeps entries for 30 seconds by default", () => {
    vi.useFakeTimers();

    const defaultGcTasksTable = defineTable("defaultGcSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = createTestDB(defaultGcTasksTable);
    let runCount = 0;

    const defaultGcTasks = selector({
      name: "defaultGcTasks",
      args: { projectId: v.string() },
      handler: function* defaultGcTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(defaultGcTasksTable, "project").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });

    initCachedSelector(testDb, defaultGcTasks, {
      projectId: "project-1",
    }).subscribe(() => {})();

    const cachedAgain = initCachedSelector(testDb, defaultGcTasks, {
      projectId: "project-1",
    });

    expect(runCount).toBe(1);

    cachedAgain.subscribe(() => {})();
    vi.advanceTimersByTime(30_000);

    initCachedSelector(testDb, defaultGcTasks, {
      projectId: "project-1",
    });

    expect(runCount).toBe(2);
  });

  test("cached object-form selector keeps entries until gcTime expires", () => {
    vi.useFakeTimers();

    const gcTasksTable = defineTable("gcSelectorTasks", {
      id: v.string(),
      projectId: v.string(),
    }).index("project", ["projectId"]);
    const testDb = createTestDB(gcTasksTable);
    let runCount = 0;

    const gcTasks = selector({
      name: "gcTasks",
      args: { projectId: v.string() },
      handler: function* gcTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(gcTasksTable, "project").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });

    const first = initCachedSelector(
      testDb,
      gcTasks,
      { projectId: "project-1" },
      { gcTime: 1000 },
    );
    first.subscribe(() => {})();

    expect(testDb.subscribers).toHaveLength(0);

    const second = initCachedSelector(
      testDb,
      gcTasks,
      { projectId: "project-1" },
      { gcTime: 1000 },
    );
    const unsubscribeSecond = second.subscribe(() => {});

    expect(runCount).toBe(1);
    expect(testDb.subscribers).toHaveLength(1);

    unsubscribeSecond();
    vi.advanceTimersByTime(1000);

    initCachedSelector(testDb, gcTasks, { projectId: "project-1" });

    expect(runCount).toBe(2);
  });

  test("works with range", () => {
    const selector = initSelector(db, () => allDoneTasks({ state: "done" }));

    const results = [selector.getSnapshot()?.[0]?.id];
    selector.subscribe(() => {
      console.log("new tasks!", selector.getSnapshot());
      results.push(selector.getSnapshot()?.[0]?.id);
    });

    execSync(
      db.insert(tasksTable, [
        {
          id: "task-1",
          title: "inserted",
          state: "done",
          projectId: "1",
          orderToken: "d",
          type: "task",
        },
      ]),
    );

    execSync(
      db.upsert(tasksTable, [
        {
          id: "task-1",
          title: "updated",
          state: "todo",
          projectId: "2",
          orderToken: "d",
          type: "task",
        },
      ]),
    );

    execSync(db.delete(tasksTable, ["task-1"]));

    expect(results).toEqual([undefined, "task-1", undefined]);
  });

  test("reruns if db changes before subscription is installed", () => {
    const testDb = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(testDb.loadTables([tasksTable]));

    const taskSelector = selector({
      name: "taskSelector",
      args: {},
      handler: function* taskSelector() {
        const tasks = yield* selectFrom(tasksTable, "byId").where((q) =>
          q.eq("id", "task-1"),
        );
        return tasks[0];
      },
    });

    const initializedSelector = initSelector(testDb, () => taskSelector({}));
    expect(initializedSelector.getSnapshot()).toBeUndefined();

    const task = {
      id: "task-1",
      title: "inserted",
      state: "done",
      projectId: "1",
      orderToken: "d",
      type: "task",
    } satisfies Task;

    execSync(testDb.insert(tasksTable, [task]));

    let callbackCount = 0;
    const unsubscribe = initializedSelector.subscribe(() => {
      callbackCount++;
    });

    expect(callbackCount).toBe(1);
    expect(initializedSelector.getSnapshot()).toEqual(task);

    unsubscribe();
  });

  test("works with equal", () => {
    const selector = initSelector(db, () => specificTask({ id: "task-1" }));

    console.log("current state", selector.getSnapshot());
    selector.subscribe(() => {
      console.log("new state!", selector.getSnapshot());
    });

    execSync(
      db.insert(tasksTable, [
        {
          id: "task-1",
          title: "inserted",
          state: "done",
          projectId: "1",
          orderToken: "d",
          type: "task",
        },
      ]),
    );

    execSync(
      db.upsert(tasksTable, [
        {
          id: "task-1",
          title: "updated",
          state: "todo",
          projectId: "2",
          orderToken: "d",
          type: "task",
        },
      ]),
    );

    execSync(db.delete(tasksTable, ["task-1"]));
  });

  test("selector subscription with projectId btree index", () => {
    type Item = {
      id: string;
      orderToken: string;
      projectId: string;
    };

    const itemsTable = defineTable("items", {
      id: v.string(),
      orderToken: v.string(),
      projectId: v.string(),
    }).index("projectIdOrder", ["projectId", "orderToken"]);

    const testDb = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(testDb.loadTables([itemsTable]));

    const project1Selector = selector({
      name: "project1Selector",
      args: {},
      handler: function* project1Selector() {
        const items = yield* selectFrom(itemsTable, "projectIdOrder").where(
          (q) => q.eq("projectId", "project1"),
        );
        return items;
      },
    });

    const project2Selector = selector({
      name: "project2Selector",
      args: {},
      handler: function* project2Selector() {
        const items = yield* selectFrom(itemsTable, "projectIdOrder").where(
          (q) => q.eq("projectId", "project2"),
        );
        return items;
      },
    });

    const selector1 = initSelector(testDb, () => project1Selector({}));
    const selector2 = initSelector(testDb, () => project2Selector({}));

    const project1Results: Item[][] = [selector1.getSnapshot()];
    const project2Results: Item[][] = [selector2.getSnapshot()];

    selector1.subscribe(() => {
      project1Results.push(selector1.getSnapshot());
    });

    selector2.subscribe(() => {
      project2Results.push(selector2.getSnapshot());
    });

    const tx = execSync(testDb.beginTx());

    execSync(
      tx.insert(itemsTable, [
        { id: "item1", orderToken: "a", projectId: "project1" },
        { id: "item2", orderToken: "b", projectId: "project1" },
      ]),
    );

    execSync(tx.commit());

    expect(project1Results).toHaveLength(2);
    expect(project2Results).toHaveLength(1);
    expect(project1Results[1]).toHaveLength(2);
    expect(project2Results[0]).toHaveLength(0);

    const tx2 = execSync(testDb.beginTx());
    execSync(
      tx2.upsert(itemsTable, [
        { id: "item1", orderToken: "c", projectId: "project2" },
      ]),
    );
    execSync(tx2.commit());

    expect(project1Results).toHaveLength(3);
    expect(project2Results).toHaveLength(2);
    expect(project1Results[2]).toHaveLength(1);
    expect(project2Results[1]).toHaveLength(1);
  });

  test("nested selectors reuse memoized children when ops miss their ranges", () => {
    const itemsTable = defineTable("nestedMemoItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);
    execSync(
      testDb.insert(itemsTable, [
        ...makeGroupRows("a", 11),
        ...makeGroupRows("b", 11),
      ]),
    );

    let runA = 0;
    let runB = 0;

    const groupItems = selector({
      name: "nestedGroupItems",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* nestedGroupItems({ group }) {
        if (group === "a") runA++;
        else runB++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });

    const parent = selector({
      name: "nestedMemoParent",
      args: {},
      handler: function* nestedMemoParent() {
        const a = yield* groupItems({ group: "a" });
        const b = yield* groupItems({ group: "b" });
        return { a: a.map((item) => item.id), b: b.map((item) => item.id) };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const snapshots: unknown[] = [];
    const unsubscribe = cached.subscribe(() => {
      snapshots.push(cached.getSnapshot());
    });

    expect(runA).toBe(1);
    expect(runB).toBe(1);
    expect(cached.getSnapshot()).toEqual({
      a: makeGroupRows("a", 11).map((item) => item.id),
      b: makeGroupRows("b", 11).map((item) => item.id),
    });

    // Op lands in child A's range -> A recomputes, B served from memo.
    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );

    expect(runA).toBe(2);
    expect(runB).toBe(1);
    expect(cached.getSnapshot()).toEqual({
      a: [...makeGroupRows("a", 11).map((item) => item.id), "a1"],
      b: makeGroupRows("b", 11).map((item) => item.id),
    });

    // Op lands in child B's range -> B recomputes, A served from memo.
    execSync(
      testDb.insert(itemsTable, [{ id: "b1", group: "b", orderToken: "a" }]),
    );

    expect(runA).toBe(2);
    expect(runB).toBe(2);
    expect(cached.getSnapshot()).toEqual({
      a: [...makeGroupRows("a", 11).map((item) => item.id), "a1"],
      b: [...makeGroupRows("b", 11).map((item) => item.id), "b1"],
    });

    expect(snapshots).toEqual([
      {
        a: [...makeGroupRows("a", 11).map((item) => item.id), "a1"],
        b: makeGroupRows("b", 11).map((item) => item.id),
      },
      {
        a: [...makeGroupRows("a", 11).map((item) => item.id), "a1"],
        b: [...makeGroupRows("b", 11).map((item) => item.id), "b1"],
      },
    ]);

    unsubscribe();
  });

  test("nested selectors are not memoized by default", () => {
    const itemsTable = defineTable("smallNestedMemoItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);

    let runA = 0;
    let runB = 0;

    const groupItems = selector({
      name: "smallNestedGroupItems",
      args: { group: v.string() },
      handler: function* smallNestedGroupItems({ group }) {
        if (group === "a") runA++;
        else runB++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });

    const parent = selector({
      name: "smallNestedMemoParent",
      args: {},
      handler: function* smallNestedMemoParent() {
        const a = yield* groupItems({ group: "a" });
        const b = yield* groupItems({ group: "b" });
        return { a: a.length, b: b.length };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );

    expect(cached.getSnapshot()).toEqual({ a: 1, b: 0 });
    expect(runA).toBe(2);
    expect(runB).toBe(2);

    unsubscribe();
  });

  test("nested selectors do not recompute when ops miss all child ranges", () => {
    const itemsTable = defineTable("nestedMissItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);

    let runA = 0;
    let runB = 0;

    const groupItems = selector({
      name: "nestedMissGroupItems",
      args: { group: v.string() },
      handler: function* nestedMissGroupItems({ group }) {
        if (group === "a") runA++;
        else runB++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });

    const parent = selector({
      name: "nestedMissParent",
      args: {},
      handler: function* nestedMissParent() {
        const a = yield* groupItems({ group: "a" });
        const b = yield* groupItems({ group: "b" });
        return { a: a.length, b: b.length };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const snapshots: unknown[] = [];
    const unsubscribe = cached.subscribe(() => {
      snapshots.push(cached.getSnapshot());
    });

    expect(runA).toBe(1);
    expect(runB).toBe(1);

    // Op in an unrelated group -> root never reruns, no child recomputes.
    execSync(
      testDb.insert(itemsTable, [{ id: "c1", group: "c", orderToken: "a" }]),
    );

    expect(runA).toBe(1);
    expect(runB).toBe(1);
    expect(snapshots).toEqual([]);

    unsubscribe();
  });

  test("nested selector with non-serializable args runs inline and uncached", () => {
    const itemsTable = defineTable("nonSerializableArgsItems", {
      id: v.string(),
      group: v.string(),
    }).index("group", ["group"]);
    const testDb = createTestDB(itemsTable);

    let childRuns = 0;

    const child = selector({
      name: "nonSerializableChild",
      args: { filter: v.any() },
      handler: function* nonSerializableChild({
        filter,
      }: {
        filter: { match: (id: string) => boolean };
      }) {
        childRuns++;
        const items = yield* selectFrom(itemsTable, "group").where((q) =>
          q.eq("group", "a"),
        );
        return items.filter((item) => filter.match(item.id));
      },
    });

    const parent = selector({
      name: "nonSerializableParent",
      args: {},
      handler: function* nonSerializableParent() {
        return yield* child({
          filter: { match: (id: string) => id.startsWith("keep") },
        });
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(childRuns).toBe(1);
    expect(cached.getSnapshot()).toEqual([]);

    execSync(
      testDb.insert(itemsTable, [
        { id: "keep-1", group: "a" },
        { id: "drop-1", group: "a" },
      ]),
    );

    expect(cached.getSnapshot().map((item) => item.id)).toEqual(["keep-1"]);
    // Non-serializable args -> no memo entry -> always runs inline on rerun.
    expect(childRuns).toBe(2);

    unsubscribe();
  });

  test("memo-skipped nested selector is marked cached in the trace", async () => {
    const deactivateTrace = hyperDBTraceStore.activate();
    hyperDBTraceStore.clear();

    try {
      const itemsTable = defineTable("cachedMarkerItems", {
        id: v.string(),
        group: v.string(),
        orderToken: v.string(),
      }).index("groupOrder", ["group", "orderToken"]);
      const testDb = createTestDB(itemsTable);
      execSync(testDb.insert(itemsTable, makeGroupRows("b", 11)));

      const groupItems = selector({
        name: "cachedMarkerGroupItems",
        args: { group: v.string() },
        memoization: { selfChild: true },
        handler: function* cachedMarkerGroupItems({ group }) {
          return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
            q.eq("group", group),
          );
        },
      });

      const parent = selector({
        name: "cachedMarkerParent",
        args: {},
        handler: function* cachedMarkerParent() {
          const a = yield* groupItems({ group: "a" });
          const b = yield* groupItems({ group: "b" });
          return { a: a.length, b: b.length };
        },
      });

      const cached = initCachedSelector(testDb, parent, {});
      const unsubscribe = cached.subscribe(() => {});

      hyperDBTraceStore.clear();

      // Op in child A's range: B is served from memo and should be marked cached.
      execSync(
        testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
      );

      await flushTraceCommits();
      const trace = selectCommittedTraces()[0]!;
      const findFrame = (
        frame: TraceFrame,
        name: string,
      ): TraceFrame | undefined => {
        if (frame.name === name) return frame;
        for (const childFrame of frame.children) {
          const found = findFrame(childFrame, name);
          if (found) return found;
        }
        return undefined;
      };

      const root = trace.frames[0]!;
      const frameA = findFrame(root, "cachedMarkerGroupItems");
      expect(frameA?.cached).toBeFalsy();
      // The second child (B) was skipped and has no scan children.
      const cachedFrames: TraceFrame[] = [];
      const collect = (frame: TraceFrame) => {
        if (frame.cached) cachedFrames.push(frame);
        frame.children.forEach(collect);
      };
      collect(root);
      expect(cachedFrames).toHaveLength(1);
      expect(cachedFrames[0]?.commandIds).toHaveLength(0);

      unsubscribe();
    } finally {
      deactivateTrace();
      hyperDBTraceStore.clear();
    }
  });

  test("nested child invalidates when a row moves between ranges or is deleted", () => {
    const itemsTable = defineTable("moveMemoItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);
    execSync(
      testDb.insert(itemsTable, [
        ...makeGroupRows("a", 11),
        { id: "x", group: "a", orderToken: "999" },
      ]),
    );

    let runA = 0;
    let runB = 0;
    const groupItems = selector({
      name: "moveMemoGroupItems",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* moveMemoGroupItems({ group }) {
        if (group === "a") runA++;
        else runB++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const parent = selector({
      name: "moveMemoParent",
      args: {},
      handler: function* moveMemoParent() {
        const a = yield* groupItems({ group: "a" });
        const b = yield* groupItems({ group: "b" });
        return { a: a.length, b: b.length };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(cached.getSnapshot()).toEqual({ a: 12, b: 0 });
    expect(runA).toBe(1);
    expect(runB).toBe(1);

    // Upsert moves x out of A (oldValue) and into B (newValue): both recompute.
    execSync(
      testDb.upsert(itemsTable, [{ id: "x", group: "b", orderToken: "a" }]),
    );

    expect(cached.getSnapshot()).toEqual({ a: 11, b: 1 });
    expect(runA).toBe(2);
    expect(runB).toBe(2);

    // Delete x (now in B): only B recomputes.
    execSync(testDb.delete(itemsTable, ["x"]));

    expect(cached.getSnapshot()).toEqual({ a: 11, b: 0 });
    expect(runA).toBe(2);
    expect(runB).toBe(3);

    unsubscribe();
  });

  test("memo-skipped nested child reuses the exact result reference", () => {
    const itemsTable = defineTable("refMemoItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);
    execSync(testDb.insert(itemsTable, makeGroupRows("b", 11)));

    const groupItems = selector({
      name: "refMemoGroupItems",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* refMemoGroupItems({ group }) {
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const parent = selector({
      name: "refMemoParent",
      args: {},
      handler: function* refMemoParent() {
        const a = yield* groupItems({ group: "a" });
        const b = yield* groupItems({ group: "b" });
        return { a, b };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    const firstA = cached.getSnapshot().a;
    const firstB = cached.getSnapshot().b;

    // Op hits A only: A is recomputed (new ref), B is reused (same ref).
    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );

    expect(cached.getSnapshot().a).not.toBe(firstA);
    expect(cached.getSnapshot().b).toBe(firstB);

    unsubscribe();
  });

  test("three-level nesting skips a whole subtree when its ranges are untouched", () => {
    const itemsTable = defineTable("threeLevelItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);
    execSync(testDb.insert(itemsTable, makeGroupRows("b", 11)));

    let leafRuns = 0;
    let midRuns = 0;

    const leaf = selector({
      name: "threeLevelLeaf",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* threeLevelLeaf({ group }) {
        leafRuns++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const mid = selector({
      name: "threeLevelMid",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* threeLevelMid({ group }) {
        midRuns++;
        const items = yield* leaf({ group });
        return items.length;
      },
    });
    const top = selector({
      name: "threeLevelTop",
      args: {},
      handler: function* threeLevelTop() {
        const a = yield* mid({ group: "a" });
        const b = yield* mid({ group: "b" });
        return { a, b };
      },
    });

    const cached = initCachedSelector(testDb, top, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(midRuns).toBe(2);
    expect(leafRuns).toBe(2);

    // Op hits group a: the entire group-b subtree (mid + leaf) is skipped.
    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );

    expect(cached.getSnapshot()).toEqual({ a: 1, b: 11 });
    expect(midRuns).toBe(3); // only mid(a) reran
    expect(leafRuns).toBe(3); // only leaf(a) reran

    unsubscribe();
  });

  test("memoized leaf can be reused through an unmemoized middle selector", () => {
    const itemsTable = defineTable("leafThroughUnmemoizedMidItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);

    let leafRuns = 0;
    let midRuns = 0;

    const leaf = selector({
      name: "leafThroughUnmemoizedMidLeaf",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* leafThroughUnmemoizedMidLeaf({ group }) {
        leafRuns++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const mid = selector({
      name: "leafThroughUnmemoizedMid",
      args: { group: v.string() },
      handler: function* leafThroughUnmemoizedMid({ group }) {
        midRuns++;
        const items = yield* leaf({ group });
        return items.length;
      },
    });
    const top = selector({
      name: "leafThroughUnmemoizedMidTop",
      args: {},
      handler: function* leafThroughUnmemoizedMidTop() {
        const a = yield* mid({ group: "a" });
        const b = yield* mid({ group: "b" });
        return { a, b };
      },
    });

    const cached = initCachedSelector(testDb, top, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(cached.getSnapshot()).toEqual({ a: 0, b: 0 });
    expect(midRuns).toBe(2);
    expect(leafRuns).toBe(2);

    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );

    expect(cached.getSnapshot()).toEqual({ a: 1, b: 0 });
    expect(midRuns).toBe(4);
    expect(leafRuns).toBe(3);

    unsubscribe();
  });

  test("a skipped ancestor keeps its subtree cached for later reruns", () => {
    const itemsTable = defineTable("deepCacheItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(itemsTable);
    execSync(
      testDb.insert(itemsTable, [
        ...makeGroupRows("a1", 11),
        ...makeGroupRows("a2", 11),
        ...makeGroupRows("b", 11),
      ]),
    );

    const leafRuns: Record<string, number> = { a1: 0, a2: 0, b: 0 };
    const leaf = selector({
      name: "deepCacheLeaf",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* deepCacheLeaf({ group }) {
        leafRuns[group] = (leafRuns[group] ?? 0) + 1;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const midA = selector({
      name: "deepCacheMidA",
      args: {},
      memoization: { selfChild: true },
      handler: function* deepCacheMidA() {
        const a1 = yield* leaf({ group: "a1" });
        const a2 = yield* leaf({ group: "a2" });
        return a1.length + a2.length;
      },
    });
    const midB = selector({
      name: "deepCacheMidB",
      args: {},
      memoization: { selfChild: true },
      handler: function* deepCacheMidB() {
        const b = yield* leaf({ group: "b" });
        return b.length;
      },
    });
    const top = selector({
      name: "deepCacheTop",
      args: {},
      handler: function* deepCacheTop() {
        const a = yield* midA({});
        const b = yield* midB({});
        return { a, b };
      },
    });

    const cached = initCachedSelector(testDb, top, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(leafRuns).toEqual({ a1: 1, a2: 1, b: 1 });

    // Op hits group b: midA is skipped (cached). Its leaves are NOT re-walked.
    execSync(
      testDb.insert(itemsTable, [{ id: "b1", group: "b", orderToken: "a" }]),
    );
    expect(leafRuns).toEqual({ a1: 1, a2: 1, b: 2 });

    // Op hits group a1: midA recomputes, leaf a1 reruns, but leaf a2 must stay
    // cached (its subtree survived midA being skipped above).
    execSync(
      testDb.insert(itemsTable, [{ id: "a1x", group: "a1", orderToken: "a" }]),
    );
    expect(leafRuns).toEqual({ a1: 2, a2: 1, b: 2 });
    expect(cached.getSnapshot()).toEqual({ a: 23, b: 12 });

    unsubscribe();
  });

  test("conditional child recomputes against current data after being absent", () => {
    const flagsTable = defineTable("condFlags", {
      id: v.string(),
      active: v.string(),
    });
    const itemsTable = defineTable("condItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(flagsTable, itemsTable);
    execSync(testDb.insert(flagsTable, [{ id: "flag", active: "a" }]));

    let runA = 0;
    let runB = 0;
    const groupItems = selector({
      name: "condGroupItems",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* condGroupItems({ group }) {
        if (group === "a") runA++;
        else runB++;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });
    const parent = selector({
      name: "condParent",
      args: {},
      handler: function* condParent() {
        const flags = yield* selectFrom(flagsTable, "byId").where((q) =>
          q.eq("id", "flag"),
        );
        const group = flags[0]?.active === "a" ? "a" : "b";
        const items = yield* groupItems({ group });
        return items.map((item) => item.id);
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(cached.getSnapshot()).toEqual([]);
    expect(runA).toBe(1);

    // Flip to branch B. Child A's ranges leave the subscription.
    execSync(testDb.upsert(flagsTable, [{ id: "flag", active: "b" }]));
    expect(cached.getSnapshot()).toEqual([]);
    expect(runB).toBe(1);

    // Mutate A's data while A is absent: no rerun (A is not subscribed).
    execSync(
      testDb.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]),
    );
    expect(cached.getSnapshot()).toEqual([]);

    // Flip back to A: the stale memo must NOT be reused; A recomputes and
    // observes the row inserted while it was absent.
    execSync(testDb.upsert(flagsTable, [{ id: "flag", active: "a" }]));
    expect(cached.getSnapshot()).toEqual(["a1"]);
    expect(runA).toBe(2);

    unsubscribe();
  });

  test("conditional descendant is pruned after its ancestor was skipped", () => {
    const flagsTable = defineTable("nestedCondFlags", {
      id: v.string(),
      active: v.string(),
    });
    const itemsTable = defineTable("nestedCondItems", {
      id: v.string(),
      group: v.string(),
      orderToken: v.string(),
    }).index("groupOrder", ["group", "orderToken"]);
    const testDb = createTestDB(flagsTable, itemsTable);
    execSync(testDb.insert(flagsTable, [{ id: "flag", active: "a" }]));
    execSync(testDb.insert(itemsTable, makeGroupRows("a", 11)));

    let midRuns = 0;
    const leafRuns: Record<string, number> = { a: 0, b: 0, sibling: 0 };

    const groupItems = selector({
      name: "nestedCondGroupItems",
      args: { group: v.string() },
      memoization: { selfChild: true },
      handler: function* nestedCondGroupItems({ group }) {
        leafRuns[group] = (leafRuns[group] ?? 0) + 1;
        return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
          q.eq("group", group),
        );
      },
    });

    const conditionalMid = selector({
      name: "nestedCondMid",
      args: {},
      memoization: { selfChild: true },
      handler: function* nestedCondMid() {
        midRuns++;
        const flags = yield* selectFrom(flagsTable, "byId").where((q) =>
          q.eq("id", "flag"),
        );
        const group = flags[0]?.active === "a" ? "a" : "b";
        const items = yield* groupItems({ group });
        return items.map((item) => item.id);
      },
    });

    const parent = selector({
      name: "nestedCondParent",
      args: {},
      handler: function* nestedCondParent() {
        const activeItems = yield* conditionalMid({});
        const siblingItems = yield* groupItems({ group: "sibling" });
        return {
          active: activeItems,
          sibling: siblingItems.map((item) => item.id),
        };
      },
    });

    const cached = initCachedSelector(testDb, parent, {});
    const unsubscribe = cached.subscribe(() => {});

    expect(cached.getSnapshot()).toEqual({
      active: makeGroupRows("a", 11).map((item) => item.id),
      sibling: [],
    });
    expect(midRuns).toBe(1);
    expect(leafRuns).toEqual({ a: 1, b: 0, sibling: 1 });

    // Touch only the sibling branch. conditionalMid should be skipped, and its
    // existing child memo should survive without being re-walked or pruned.
    execSync(
      testDb.insert(itemsTable, [
        { id: "sibling-1", group: "sibling", orderToken: "a" },
      ]),
    );

    expect(cached.getSnapshot()).toEqual({
      active: makeGroupRows("a", 11).map((item) => item.id),
      sibling: ["sibling-1"],
    });
    expect(midRuns).toBe(1);
    expect(leafRuns).toEqual({ a: 1, b: 0, sibling: 2 });

    // Now rerun conditionalMid and switch branches. Its old "a" descendant
    // must be pruned because that range leaves the subscription.
    execSync(testDb.upsert(flagsTable, [{ id: "flag", active: "b" }]));

    expect(cached.getSnapshot()).toEqual({
      active: [],
      sibling: ["sibling-1"],
    });
    expect(midRuns).toBe(2);
    expect(leafRuns).toEqual({ a: 1, b: 1, sibling: 2 });

    // Mutate the absent "a" branch. If the stale descendant memo was kept, the
    // later switch back would incorrectly reuse the old 11-row result.
    execSync(
      testDb.insert(itemsTable, [
        { id: "a-extra", group: "a", orderToken: "999" },
      ]),
    );
    expect(cached.getSnapshot()).toEqual({
      active: [],
      sibling: ["sibling-1"],
    });

    execSync(testDb.upsert(flagsTable, [{ id: "flag", active: "a" }]));

    expect(cached.getSnapshot()).toEqual({
      active: [...makeGroupRows("a", 11).map((item) => item.id), "a-extra"],
      sibling: ["sibling-1"],
    });
    expect(midRuns).toBe(3);
    expect(leafRuns).toEqual({ a: 2, b: 1, sibling: 2 });

    unsubscribe();
  });

  test("selector preserves query order after rerun", () => {
    const itemsTable = defineTable("orderedSelectorItems", {
      id: v.string(),
      orderToken: v.string(),
      projectId: v.string(),
    }).index("projectIdOrder", ["projectId", "orderToken"]);

    const testDb = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(testDb.loadTables([itemsTable]));
    execSync(
      testDb.insert(itemsTable, [
        { id: "one", orderToken: "a", projectId: "project1" },
        { id: "three", orderToken: "c", projectId: "project1" },
        { id: "two", orderToken: "b", projectId: "project1" },
      ]),
    );

    const orderedSelector = selector({
      name: "orderedSelector",
      args: {},
      handler: function* orderedSelector() {
        const items = yield* selectFrom(itemsTable, "projectIdOrder")
          .where((q) => q.eq("projectId", "project1"))
          .order("desc");
        return items;
      },
    });

    const initializedSelector = initSelector(testDb, () => orderedSelector({}));
    const snapshots: string[][] = [];
    initializedSelector.subscribe(() => {
      snapshots.push(initializedSelector.getSnapshot().map((item) => item.id));
    });

    expect(initializedSelector.getSnapshot().map((item) => item.id)).toEqual([
      "three",
      "two",
      "one",
    ]);

    execSync(
      testDb.upsert(itemsTable, [
        { id: "one", orderToken: "d", projectId: "project1" },
      ]),
    );

    expect(initializedSelector.getSnapshot().map((item) => item.id)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(snapshots).toEqual([["one", "three", "two"]]);
  });
});
