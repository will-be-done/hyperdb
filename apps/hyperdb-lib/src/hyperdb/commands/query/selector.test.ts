import { afterEach, describe, expect, test, vi } from "vitest";
import { DB, execSync } from "../../db";
import { selector, initSelector, initCachedSelector, select } from "./selector";
import { SubscribableDB } from "../../runtime/subscribable-db";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../../schema/table";
import { selectFrom } from "./builder";
import { v } from "../../schema/values";
import { getGeneratorTraceMeta } from "../../tracing/metadata";

type Task = {
  type: "task";
  id: string;
  title: string;
  state: "todo" | "done";
  projectId: string;
  orderToken: string;
};

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

const allTasks = selector(function* () {
  const tasks = yield* selectFrom(tasksTable, "projectIdState").where((q) =>
    q.eq("projectId", "1"),
  );

  return tasks;
});

const justSelector = selector(function () {
  return "just selector";
});

const allDoneTasks = selector(function* (state: Task["state"]) {
  const tasks = yield* allTasks();

  console.log("justSelector", yield* justSelector());

  return tasks.filter((task) => task.state === state);
});

const specificTask = selector(function* (id: string) {
  const tasks = yield* selectFrom(tasksTable, "byId").where((q) =>
    q.eq("id", id),
  );
  return tasks[0];
});

const createTestDB = (...tables: Parameters<SubscribableDB["loadTables"]>[0]) => {
  const testDb = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(testDb.loadTables(tables));
  return testDb;
};

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

    expect(select(testDb, doneProjectTasks({ projectId: "project-1" }))).toEqual([
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
      handler: function* ({ id }) {
        return id;
      },
    });

    const gen = metadataSelector({ id: "task-1" });
    const traceMeta = getGeneratorTraceMeta(gen);

    expect(metadataSelector.kind).toBe("selector");
    expect(metadataSelector.name).toBe("metadataSelector");
    expect(metadataSelector.args).toBe(args);
    expect(traceMeta?.name).toBe("metadataSelector");
    expect(traceMeta?.arg).toEqual({ id: "task-1" });
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
    expect(testDb.subscribers).toHaveLength(0);
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
    const selector = initSelector(db, () => allDoneTasks("done"));

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

    const taskSelector = selector(function* () {
      const tasks = yield* selectFrom(tasksTable, "byId").where((q) =>
        q.eq("id", "task-1"),
      );
      return tasks[0];
    });

    const initializedSelector = initSelector(testDb, () => taskSelector());
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
    const selector = initSelector(db, () => specificTask("task-1"));

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

    const project1Selector = selector(function* () {
      const items = yield* selectFrom(itemsTable, "projectIdOrder").where((q) =>
        q.eq("projectId", "project1"),
      );
      return items;
    });

    const project2Selector = selector(function* () {
      const items = yield* selectFrom(itemsTable, "projectIdOrder").where((q) =>
        q.eq("projectId", "project2"),
      );
      return items;
    });

    const selector1 = initSelector(testDb, () => project1Selector());
    const selector2 = initSelector(testDb, () => project2Selector());

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

    const orderedSelector = selector(function* () {
      const items = yield* selectFrom(itemsTable, "projectIdOrder")
        .where((q) => q.eq("projectId", "project1"))
        .order("desc");
      return items;
    });

    const initializedSelector = initSelector(testDb, () => orderedSelector());
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
