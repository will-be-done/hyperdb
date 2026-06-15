import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { DB, execSync } from "../hyperdb/db";
import { BptreeInmemDriver } from "../hyperdb/drivers/inmemory/bptree-inmem-driver";
import { SubscribableDB } from "../hyperdb/runtime/subscribable-db";
import {
  HyperDBDevtools,
  HyperDBDevtoolsPanel,
  formatCallTreeOperation,
  formatSelectQuery,
  formatTraceQueriedRowCount,
  getCallTreeOperationBadges,
  getCallTreeOperations,
  getMutationDisplay,
  getTraceActionCount,
  getTraceMutatedRowCount,
  getTraceQueriedRowCount,
  isFullyCachedTrace,
} from "./components";
import {
  beginSelectEvent,
  createTraceFrameMeta,
  endSelectEventSuccess,
  endTraceSuccess,
  hyperDBTraceStore,
  recordCachedRootTrace,
  startRootTrace,
} from "../hyperdb/tracing/store";
import type { SelectCommandEvent } from "../hyperdb/tracing/store";
import type {
  MutationEvent,
  RootTrace,
  TraceFrame,
} from "../hyperdb/tracing/store";

const createDB = (): SubscribableDB => {
  const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables([]));
  return db;
};

afterEach(() => {
  vi.unstubAllGlobals();
  hyperDBTraceStore.clear();
});

describe("HyperDBDevtools", () => {
  it("renders the toggle and panel", () => {
    const html = renderToString(
      <HyperDBDevtools db={createDB()} initialIsOpen />,
    );

    expect(html).toContain("HDB");
    expect(html).toContain("HyperDB");
    expect(html).toContain("Clear");
  });

  it("renders selected trace details in the panel", () => {
    const unsubscribe = hyperDBTraceStore.subscribe(() => {});
    const context = startRootTrace(
      createTraceFrameMeta("action", "sampleAction", { id: "task-1" }),
    )!;
    endTraceSuccess(context);
    unsubscribe();

    const html = renderToString(<HyperDBDevtoolsPanel db={createDB()} />);

    expect(html).toContain("sampleAction");
    expect(html).toContain("Overview");
  });

  it("renders queried and mutated row totals in the trace list and overview", () => {
    const unsubscribe = hyperDBTraceStore.subscribe(() => {});
    const context = startRootTrace(
      createTraceFrameMeta("selector", "largeSelector", undefined),
    )!;
    const event = beginSelectEvent(context, context.rootFrame, {
      tableName: "tasks",
      index: "byProject",
      where: [],
      bounds: [],
    });
    endSelectEventSuccess(context, event, [
      { id: "task-1" },
      { id: "task-2" },
      { id: "task-3" },
    ]);
    endTraceSuccess(context);
    unsubscribe();

    const html = renderToString(<HyperDBDevtoolsPanel db={createDB()} />);

    expect(html).toContain("Rows queried");
    expect(html).toContain("Actions");
    expect(html).toContain("Rows mutated");
    expect(html).toContain("3 rows");
    expect(html).toContain("0 rows");
    expect(html).toContain("0 actions");
  });

  it("renders a cached label in the traces list for fully cached traces", () => {
    const unsubscribe = hyperDBTraceStore.subscribe(() => {});
    const db = createDB();
    recordCachedRootTrace(
      createTraceFrameMeta("selector", "cachedListSelector", {
        projectId: "project-1",
      }),
      db,
    );
    unsubscribe();

    const trace = hyperDBTraceStore.getSnapshot()[0]!;
    const html = renderToString(<HyperDBDevtoolsPanel db={db} />);

    expect(isFullyCachedTrace(trace)).toBe(true);
    expect(html).toContain("cachedListSelector");
    expect(html).toContain("[cached]");
  });

  it("renders a database selector when traces come from multiple dbs", () => {
    const unsubscribe = hyperDBTraceStore.subscribe(() => {});
    const firstDB = createDB();
    const secondDB = createDB();
    const firstContext = startRootTrace(
      createTraceFrameMeta("action", "firstDBAction", undefined),
      hyperDBTraceStore,
      firstDB,
    )!;
    endTraceSuccess(firstContext);
    const secondContext = startRootTrace(
      createTraceFrameMeta("selector", "secondDBSelector", undefined),
      hyperDBTraceStore,
      secondDB,
    )!;
    endTraceSuccess(secondContext);
    unsubscribe();

    const html = renderToString(<HyperDBDevtoolsPanel db={firstDB} />);

    expect(html).toContain("<select");
    expect(html).toContain("<option");
    expect(html).toContain("firstDBAction");
    expect(html).not.toContain("secondDBSelector");
  });

  it("keeps the current database option when it has no traces", () => {
    const unsubscribe = hyperDBTraceStore.subscribe(() => {});
    const firstDB = createDB();
    const secondDB = createDB();
    const secondContext = startRootTrace(
      createTraceFrameMeta("selector", "secondDBSelector", undefined),
      hyperDBTraceStore,
      secondDB,
    )!;
    endTraceSuccess(secondContext);
    unsubscribe();

    const html = renderToString(<HyperDBDevtoolsPanel db={firstDB} />);

    expect(html).toContain("<select");
    expect(html.match(/<option/g)).toHaveLength(2);
    expect(html).toContain("No traces");
    expect(html).not.toContain("secondDBSelector");
  });

  it("respects localStorage open state", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "true",
      setItem: () => {},
    });

    const html = renderToString(
      <HyperDBDevtools db={createDB()} initialIsOpen={false} />,
    );

    expect(html).toContain("Close HyperDB Devtools");
    expect(html).toContain("Clear");
  });

  it("falls back when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("fail");
      },
      setItem: () => {},
    });

    const html = renderToString(
      <HyperDBDevtools db={createDB()} initialIsOpen={false} />,
    );

    expect(html).toContain("Open HyperDB Devtools");
    expect(html).not.toContain("Clear");
  });

  it("formats select events as SQL-like queries", () => {
    const event: SelectCommandEvent = {
      id: "cmd-1",
      frameId: "frame-1",
      kind: "select",
      tableName: "devtoolTasks",
      index: "projectState",
      where: [
        {
          eq: [{ col: "projectId", val: "project-1" }],
          gt: [],
          gte: [],
          lt: [],
          lte: [{ col: "title", val: "Bob's task" }],
        },
      ],
      bounds: [],
      limit: 5,
      order: "asc",
      startedAt: 0,
      status: "success",
      resultCount: 1,
    };

    expect(formatSelectQuery(event)).toBe(
      [
        "SELECT projectState",
        "FROM devtoolTasks",
        "WHERE projectId = 'project-1' AND title <= 'Bob''s task'",
        "ORDER BY projectState ASC",
        "LIMIT 5;",
      ].join("\n"),
    );
  });

  it("formats alternative where clauses as OR groups", () => {
    const event: SelectCommandEvent = {
      id: "cmd-1",
      frameId: "frame-1",
      kind: "select",
      tableName: "devtoolTasks",
      index: "projectState",
      where: [
        {
          eq: [{ col: "state", val: "todo" }],
          gt: [],
          gte: [],
          lt: [],
          lte: [],
        },
        {
          eq: [{ col: "state", val: "done" }],
          gt: [],
          gte: [],
          lt: [],
          lte: [],
        },
      ],
      bounds: [],
      startedAt: 0,
      status: "success",
    };

    expect(formatSelectQuery(event)).toBe(
      [
        "SELECT projectState",
        "FROM devtoolTasks",
        "WHERE (state = 'todo') OR (state = 'done');",
      ].join("\n"),
    );
  });

  it("shows inserted rows for insert mutations", () => {
    const rows = [{ id: "project-1" }, { id: "project-2" }];
    const event: MutationEvent = {
      id: "mutation-1",
      frameId: "frame-1",
      kind: "insert",
      tableName: "projects",
      rows,
      newValue: rows,
      startedAt: 100,
      status: "success",
    };

    expect(getMutationDisplay(event)).toEqual([
      { variant: "rows", label: "Inserted", total: 2, rows },
    ]);
  });

  it("shows deleted rows (or ids) for delete mutations", () => {
    const oldValue = [{ id: "project-1" }];
    const event: MutationEvent = {
      id: "mutation-1",
      frameId: "frame-1",
      kind: "delete",
      tableName: "projects",
      ids: ["project-1"],
      oldValue,
      startedAt: 100,
      status: "success",
    };

    expect(getMutationDisplay(event)).toEqual([
      { variant: "rows", label: "Deleted", total: 1, rows: oldValue },
    ]);
  });

  it("splits upserts into old/new updates and inserts", () => {
    const oldTask = { id: "task-1", state: "todo" };
    const updatedTask = { id: "task-1", state: "done" };
    const newTask = { id: "task-2", state: "todo" };
    const event: MutationEvent = {
      id: "mutation-1",
      frameId: "frame-1",
      kind: "upsert",
      tableName: "tasks",
      rows: [updatedTask, newTask],
      newValue: [updatedTask, newTask],
      oldValue: [oldTask],
      startedAt: 100,
      status: "success",
    };

    expect(getMutationDisplay(event)).toEqual([
      {
        variant: "updates",
        label: "Updated",
        total: 1,
        updates: [{ old: oldTask, new: updatedTask }],
      },
      { variant: "rows", label: "Inserted", total: 1, rows: [newTask] },
    ]);
  });

  it("limits mutation display rows and reports the omitted count", () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({
      id: `project-${index}`,
    }));
    const event: MutationEvent = {
      id: "mutation-1",
      frameId: "frame-1",
      kind: "insert",
      tableName: "projects",
      rows,
      newValue: rows,
      startedAt: 100,
      status: "success",
    };

    const [section] = getMutationDisplay(event);

    expect(section.variant).toBe("rows");
    expect(section.total).toBe(35);
    expect(section.variant === "rows" && section.rows).toHaveLength(30);
    expect(section.preview).toEqual({ shown: 30, total: 35, omitted: 5 });
    expect(event.rows).toHaveLength(35);
  });

  it("aggregates queried, mutated, and action counts across a trace", () => {
    const rootFrame: TraceFrame = {
      id: "frame-1",
      kind: "action",
      name: "loadTasks",
      arg: undefined,
      startedAt: 100,
      status: "running",
      children: [
        {
          id: "frame-2",
          parentId: "frame-1",
          kind: "selector",
          name: "getTasks",
          arg: undefined,
          startedAt: 110,
          status: "running",
          children: [
            {
              id: "frame-3",
              parentId: "frame-2",
              kind: "action",
              name: "touchTask",
              arg: undefined,
              startedAt: 120,
              status: "running",
              children: [],
              commandIds: [],
              mutationIds: [],
            },
          ],
          commandIds: [],
          mutationIds: [],
        },
      ],
      commandIds: [],
      mutationIds: [],
    };
    const trace: RootTrace = {
      id: "trace-1",
      kind: "action",
      name: "loadTasks",
      arg: undefined,
      startedAt: 100,
      status: "running",
      frames: [rootFrame],
      commandEvents: [
        {
          id: "cmd-1",
          frameId: "frame-1",
          kind: "select",
          tableName: "tasks",
          index: "byProject",
          where: [],
          bounds: [],
          startedAt: 110,
          status: "success",
          resultCount: 3,
        },
        {
          id: "cmd-2",
          frameId: "frame-1",
          kind: "select",
          tableName: "comments",
          index: "byTask",
          where: [],
          bounds: [],
          startedAt: 120,
          status: "running",
        },
      ],
      mutationEvents: [
        {
          id: "mutation-1",
          frameId: "frame-3",
          kind: "insert",
          tableName: "tasks",
          rows: [{ id: "task-1" }, { id: "task-2" }],
          startedAt: 130,
          status: "success",
        },
        {
          id: "mutation-2",
          frameId: "frame-3",
          kind: "upsert",
          tableName: "tasks",
          newValue: [{ id: "task-3" }],
          startedAt: 140,
          status: "success",
        },
        {
          id: "mutation-3",
          frameId: "frame-3",
          kind: "delete",
          tableName: "tasks",
          ids: ["task-4"],
          startedAt: 150,
          status: "success",
        },
      ],
    };

    expect(getTraceQueriedRowCount(trace)).toBe(3);
    expect(formatTraceQueriedRowCount(trace)).toBe("3+");
    expect(getTraceActionCount(trace)).toBe(2);
    expect(getTraceMutatedRowCount(trace)).toBe(4);
  });

  it("orders call tree operations within a frame", () => {
    const rootFrame: TraceFrame = {
      id: "frame-1",
      kind: "action",
      name: "insertProject",
      arg: undefined,
      startedAt: 100,
      durationMs: 200,
      status: "success",
      children: [
        {
          id: "frame-4",
          parentId: "frame-1",
          kind: "action",
          name: "insertFirstTask",
          arg: undefined,
          startedAt: 140,
          durationMs: 50,
          status: "success",
          children: [],
          commandIds: [],
          mutationIds: [],
        },
      ],
      commandIds: ["cmd-2", "cmd-6"],
      mutationIds: ["mutation-3"],
    };

    const selectProject: SelectCommandEvent = {
      id: "cmd-2",
      frameId: "frame-1",
      kind: "select",
      tableName: "projects",
      index: "byId",
      where: [],
      bounds: [],
      startedAt: 110,
      durationMs: 50,
      status: "success",
      resultCount: 1,
    };
    const selectTasks: SelectCommandEvent = {
      id: "cmd-6",
      frameId: "frame-1",
      kind: "select",
      tableName: "tasks",
      index: "byProjectId",
      where: [],
      bounds: [],
      startedAt: 130,
      durationMs: 50,
      status: "success",
      resultCount: 2,
    };
    const insertProject: MutationEvent = {
      id: "mutation-3",
      frameId: "frame-1",
      kind: "insert",
      tableName: "projects",
      rows: [{ id: "project-1" }, { id: "project-2" }],
      startedAt: 120,
      durationMs: 50,
      status: "success",
    };
    const trace: RootTrace = {
      id: "trace-1",
      kind: "action",
      name: "insertProject",
      arg: undefined,
      startedAt: 100,
      durationMs: 200,
      status: "success",
      frames: [rootFrame],
      commandEvents: [selectTasks, selectProject],
      mutationEvents: [insertProject],
    };

    const operations = getCallTreeOperations(rootFrame, trace);

    expect(operations.map((operation) => operation.id)).toEqual([
      "cmd-2",
      "mutation-3",
      "cmd-6",
      "frame-4",
    ]);
    expect(operations.map(formatCallTreeOperation)).toEqual([
      "select projects.byId",
      "insert projects",
      "select tasks.byProjectId",
      "@insertFirstTask",
    ]);
    expect(operations.map(getCallTreeOperationBadges)).toEqual([
      [
        { text: "50ms", tone: "duration" },
        { text: "1 row", tone: "rows" },
      ],
      [
        { text: "50ms", tone: "duration" },
        { text: "2 rows", tone: "rows" },
      ],
      [
        { text: "50ms", tone: "duration" },
        { text: "2 rows", tone: "rows" },
      ],
      [{ text: "50ms", tone: "duration" }],
    ]);
  });

  it("adds a cached badge for memoized selector frames", () => {
    const cachedFrame: TraceFrame = {
      id: "frame-cached",
      kind: "selector",
      name: "cachedChild",
      arg: undefined,
      startedAt: 100,
      durationMs: 2,
      status: "success",
      cached: true,
      children: [],
      commandIds: [],
      mutationIds: [],
    };
    const rootFrame: TraceFrame = {
      id: "frame-root",
      kind: "selector",
      name: "parent",
      arg: undefined,
      startedAt: 90,
      durationMs: 5,
      status: "success",
      children: [cachedFrame],
      commandIds: [],
      mutationIds: [],
    };
    const trace: RootTrace = {
      id: "trace-cached",
      kind: "selector",
      name: "parent",
      arg: undefined,
      startedAt: 90,
      durationMs: 5,
      status: "success",
      frames: [rootFrame],
      commandEvents: [],
      mutationEvents: [],
    };

    const operations = getCallTreeOperations(rootFrame, trace);
    const cachedOperation = operations.find(
      (operation) =>
        operation.kind === "frame" && operation.frame.id === "frame-cached",
    )!;

    expect(getCallTreeOperationBadges(cachedOperation)).toEqual([
      { text: "2ms", tone: "duration" },
      { text: "cached", tone: "cached" },
    ]);
    // The label itself stays clean; the marker is a badge.
    expect(formatCallTreeOperation(cachedOperation)).toBe("@cachedChild");
  });
});
