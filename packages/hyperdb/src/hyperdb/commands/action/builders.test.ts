import { describe, expect, it } from "vitest";
import { defineTable } from "../../schema/table";
import { DB, execSync } from "../../db";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import {
  createAction,
  asyncDispatch,
  deleteRows,
  syncDispatch,
  insert,
  upsert,
} from "./builders";
import { selectFrom } from "../selector/builder";
import { createSelector } from "../selector/selector";
import { v } from "../../schema/values";
import { getGeneratorTraceMeta } from "../../tracing/metadata";
import { SubscribableDB } from "../../runtime/subscribable-db";
import { unwrap } from "../async";

const action = createAction();

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

const updateAction = action({
  name: "updateAction",
  args: {},
  handler: function* updateAction() {
    const task: Task = {
      type: "task",
      id: "task-1",
      title: "Task 1",
      state: "todo",
      projectId: "project-1",
      orderToken: "b",
    };

    yield* upsert(tasksTables, [task]);
  },
});

const insertAction = action({
  name: "insertAction",
  args: {},
  handler: function* insertAction() {
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

    yield* updateAction({});

    const tasks2 = yield* selectFrom(tasksTables, "title").where((q) =>
      q.eq("title", "Task 1"),
    );

    yield* deleteRows(tasksTables, ["task-1"]);

    const tasks3 = yield* selectFrom(tasksTables, "title").where((q) =>
      q.eq("title", "Task 1"),
    );

    return [tasks, tasks2, tasks3];
  },
});

describe("action", () => {
  it("publishes cached async dispatches before returning", async () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTables]));
    let published = false;
    db.subscribe(() => {
      published = true;
    });

    const pending = asyncDispatch(db, updateAction({}));

    expect(published).toBe(true);
    await pending;
  });

  it("resumes the same action after async work and rolls back failures", async () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTables]));
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let runs = 0;
    let published = false;
    db.subscribe(() => {
      published = true;
    });
    const failing = action({
      name: "failingAsyncAction",
      args: {},
      handler: function* () {
        runs++;
        yield* updateAction({});
        yield* unwrap(gate);
      },
    });
    const pending = asyncDispatch(db, failing({}));
    const failure = new Error("read failed");
    const rejected = expect(pending).rejects.toBe(failure);
    reject(failure);
    await rejected;

    expect(runs).toBe(1);
    expect(published).toBe(false);
    expect(
      execSync(
        db.intervalScan(tasksTables, "byId", [
          { eq: [{ col: "id", val: "task-1" }] },
        ]),
      ),
    ).toEqual([]);
    await asyncDispatch(db, updateAction({}));
    expect(published).toBe(true);
  });

  it("rolls back a sync dispatch that reaches an async step", () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTables]));
    const asyncStep = action({
      name: "asyncStepAction",
      args: {},
      handler: function* () {
        yield* updateAction({});
        yield* unwrap(Promise.resolve());
      },
    });

    expect(() => syncDispatch(db, asyncStep({}))).toThrow(
      expect.objectContaining({ code: "ASYNC_IN_SYNC_EXECUTION" }),
    );
    expect(
      execSync(
        db.intervalScan(tasksTables, "byId", [
          { eq: [{ col: "id", val: "task-1" }] },
        ]),
      ),
    ).toEqual([]);
    // The transaction was released: the next dispatch runs normally.
    syncDispatch(db, updateAction({}));
  });

  it("does not commit a sync dispatch whose handler catches the async step", () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTables]));
    const swallowingStep = action({
      name: "swallowingAsyncStepAction",
      args: {},
      handler: function* () {
        yield* updateAction({});
        try {
          yield* unwrap(Promise.resolve());
        } catch {
          return "fallback";
        }
        return "done";
      },
    });

    expect(() => syncDispatch(db, swallowingStep({}))).toThrow(
      expect.objectContaining({ code: "ASYNC_IN_SYNC_EXECUTION" }),
    );
    expect(
      execSync(
        db.intervalScan(tasksTables, "byId", [
          { eq: [{ col: "id", val: "task-1" }] },
        ]),
      ),
    ).toEqual([]);
  });

  it("does not commit a sync dispatch when a nested selector replaces the async error", () => {
    const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
    execSync(db.loadTables([tasksTables]));
    const rewrapping = createSelector()({
      name: "rewrappingAsyncSelector",
      args: {},
      handler: function* () {
        try {
          yield* unwrap(Promise.resolve());
        } catch {
          throw new Error("replaced");
        }
        return "done";
      },
    });
    const swallowingStep = action({
      name: "swallowingNestedAsyncAction",
      args: {},
      handler: function* () {
        yield* updateAction({});
        try {
          yield* rewrapping({});
        } catch {
          return "fallback";
        }
        return "done";
      },
    });
    let notified = false;
    db.subscribe(() => {
      notified = true;
    });

    expect(() => syncDispatch(db, swallowingStep({}))).toThrow(
      expect.objectContaining({ code: "ASYNC_IN_SYNC_EXECUTION" }),
    );
    expect(notified).toBe(false);
    expect(
      execSync(
        db.intervalScan(tasksTables, "byId", [
          { eq: [{ col: "id", val: "task-1" }] },
        ]),
      ),
    ).toEqual([]);
  });

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
    expect(createTask.trace).toEqual({
      enabled: true,
      startOn: "devtoolOpen",
    });
    expect(createTask.validateArgs).toBe(false);
    expect(traceMeta?.name).toBe("createTask");
    expect(traceMeta?.arg).toEqual({ id: "task-1" });
  });

  it("object-form action can skip tracing", () => {
    const skipped = action({
      name: "skippedAction",
      args: {},
      skipTrace: true,
      handler: function* () {
        return "done";
      },
    });

    const gen = skipped({});
    const traceMeta = getGeneratorTraceMeta(gen);

    expect(skipped.skipTrace).toBe(true);
    expect(traceMeta?.skipChildTrace).toBe(true);
    expect(traceMeta?.skipRootTrace).toBe(true);
  });

  it("createAction can enable and disable object args validation", () => {
    const validatingAction = createAction({ validateArgs: true });
    const looseAction = createAction({ validateArgs: false });

    const validated = validatingAction({
      name: "validatedArgsAction",
      args: { id: v.string() },
      handler: function* ({ id }) {
        return id;
      },
    });
    const loose = looseAction({
      name: "looseArgsAction",
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

  it("action builder configure updates existing actions", () => {
    const configurableAction = createAction({
      trace: { enabled: true, startOn: "devtoolOpen" },
      validateArgs: false,
    });

    const configured = configurableAction({
      name: "configuredAction",
      args: { id: v.string() },
      handler: function* ({ id }) {
        return id;
      },
    });

    configurableAction.configure({
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

    expect(syncDispatch(db, insertAction({}))).toEqual([
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
