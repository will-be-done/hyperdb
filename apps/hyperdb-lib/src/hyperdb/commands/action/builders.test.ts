import { describe, expect, it } from "vitest";
import { defineTable } from "../../schema/table";
import { DB, execSync } from "../../db";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import { action, deleteRows, syncDispatch, insert, upsert } from "./builders";
import { selectFrom } from "../query/builder";
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

const tasksTables = defineTable("tasks", {
  type: v.literal("task"),
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  projectId: v.string(),
  orderToken: v.string(),
}).index("title", ["title"], { type: "hash" });

const updateAction = action(function* () {
  const task: Task = {
    type: "task",
    id: "task-1",
    title: "Task 1",
    state: "todo",
    projectId: "project-1",
    orderToken: "b",
  };

  yield* upsert(tasksTables, [task]);
});

const insertAction = action(function* () {
  const task: Task = {
    type: "task",
    id: "task-1",
    title: "Task 1",
    state: "todo",
    projectId: "project-1",
    orderToken: "a",
  };

  yield* insert(tasksTables, [task]);

  const tasks = yield* selectFrom(tasksTables, "title").where((q) =>
    q.eq("title", "Task 1"),
  );

  yield* updateAction();

  const tasks2 = yield* selectFrom(tasksTables, "title").where((q) =>
    q.eq("title", "Task 1"),
  );

  yield* deleteRows(tasksTables, ["task-1"]);

  const tasks3 = yield* selectFrom(tasksTables, "title").where((q) =>
    q.eq("title", "Task 1"),
  );

  return [tasks, tasks2, tasks3];
});

describe("action", () => {
  it("dispatches object-form actions with one args object", () => {
    const driver = new BptreeInmemDriver();
    const db = new DB(driver);
    execSync(db.loadTables([tasksTables]));

    const createTask = action({
      name: "createTask",
      args: {
        id: v.string(),
        title: v.string(),
      },
      handler: function* ({ id, title }) {
        const task: Task = {
          type: "task",
          id,
          title,
          state: "todo",
          projectId: "project-1",
          orderToken: "a",
        };

        yield* insert(tasksTables, [task]);

        return yield* selectFrom(tasksTables, "title").where((q) =>
          q.eq("title", title),
        );
      },
    });

    expect(
      syncDispatch(
        db,
        createTask({
          id: "task-1",
          title: "Task 1",
        }),
      ),
    ).toEqual([
      {
        type: "task",
        id: "task-1",
        title: "Task 1",
        state: "todo",
        projectId: "project-1",
        orderToken: "a",
      },
    ]);
  });

  it("object-form action exposes metadata and traces the args object", () => {
    const args = { id: v.string() };
    const createTask = action({
      name: "createTask",
      args,
      handler: function* ({ id }) {
        return id;
      },
    });

    const gen = createTask({ id: "task-1" });
    const traceMeta = getGeneratorTraceMeta(gen);

    expect(createTask.kind).toBe("action");
    expect(createTask.name).toBe("createTask");
    expect(createTask.args).toBe(args);
    expect(traceMeta?.name).toBe("createTask");
    expect(traceMeta?.arg).toEqual({ id: "task-1" });
  });

  it("object-form action requires an explicit name", () => {
    expect(() =>
      action({
        args: {},
        handler: function* missingActionName() {
          return null;
        },
      } as never),
    ).toThrow("Action name is required");

    expect(() =>
      action({
        name: "",
        args: {},
        handler: function* blankActionName() {
          return null;
        },
      }),
    ).toThrow("Action name is required");
  });

  it("should dispatch actions", () => {
    const driver = new BptreeInmemDriver();
    const db = new DB(driver);
    execSync(db.loadTables([tasksTables]));

    expect(syncDispatch(db, insertAction())).toEqual([
      [
        {
          type: "task",
          id: "task-1",
          title: "Task 1",
          state: "todo",
          projectId: "project-1",
          orderToken: "a",
        },
      ],
      [
        {
          type: "task",
          id: "task-1",
          title: "Task 1",
          state: "todo",
          projectId: "project-1",
          orderToken: "b",
        },
      ],
      [],
    ]);
  });
});
