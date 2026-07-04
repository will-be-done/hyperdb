import { describe, expect, it, vi } from "vitest";
import { DB, execSync } from "../../db";
import { unwrap } from "../async";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import { SubscribableDB } from "../../runtime/subscribable-db";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { selectFrom } from "./builder";
import {
  createAsyncSelectorStore,
  createCachedSelectorStoreAsync,
} from "./async-selector-store";
import { createSelector } from "./selector";

const selector = createSelector();

const createTestDB = (
  ...tables: Parameters<SubscribableDB["loadTables"]>[0]
) => {
  const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables(tables));
  return db;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
};

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe("createCachedSelectorStoreAsync", () => {
  it("returns an immediate success snapshot on first getSnapshot when the selector resolves synchronously", () => {
    const tasksTable = defineTable("asyncStoreSyncFirstTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const db = createTestDB(tasksTable);
    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "First" },
      ]),
    );
    const projectTasks = selector({
      name: "asyncStoreSyncFirstProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        return yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });
    let reachedPromiseTick = false;
    void Promise.resolve().then(() => {
      reachedPromiseTick = true;
    });

    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      defaultValue: [],
    });
    const snapshot = store.getSnapshot();

    expect(reachedPromiseTick).toBe(false);
    expect(snapshot.status).toBe("success");
    expect(snapshot.fetchStatus).toBe("idle");
    expect(snapshot.data).toEqual([
      { id: "task-1", projectId: "project-1", title: "First" },
    ]);

    store.destroy();
  });

  it("returns pending first and then success when the selector resolves asynchronously", async () => {
    const gate = deferred<string>();
    const db = createTestDB();
    const asyncValue = selector({
      name: "asyncStorePendingValue",
      args: {},
      *handler() {
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
    });

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: undefined,
        fetchStatus: "fetching",
        status: "pending",
      }),
    );

    gate.resolve("ready");
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: "ready",
        fetchStatus: "idle",
        status: "success",
      }),
    );

    store.destroy();
  });

  it("reruns subscribed selectors only when DB changes overlap recorded ranges", () => {
    const tasksTable = defineTable("asyncStoreRangeTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const db = createTestDB(tasksTable);
    const projectTasks = selector({
      name: "asyncStoreRangeProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        return yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(store.getSnapshot().data).toEqual([]);
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);

    execSync(
      db.insert(tasksTable, [
        { id: "task-2", projectId: "project-2", title: "Ignored" },
      ]),
    );

    expect(subscriber).not.toHaveBeenCalled();
    expect(store.getSnapshot().data).toEqual([]);

    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "Included" },
      ]),
    );

    expect(subscriber).toHaveBeenCalled();
    expect(store.getSnapshot().data).toEqual([
      { id: "task-1", projectId: "project-1", title: "Included" },
    ]);

    unsubscribe();
    store.destroy();
  });

  it("reruns subscribed full-index selectors after inserts", () => {
    const spacesTable = defineTable("asyncStoreFullScanSpaces", {
      id: v.string(),
      name: v.string(),
    }).index("byIds", ["id"]);
    const db = createTestDB(spacesTable);
    const listSpaces = selector({
      name: "asyncStoreFullScanListSpaces",
      args: {},
      *handler() {
        return yield* selectFrom(spacesTable, "byIds");
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: listSpaces,
      args: {},
      defaultValue: [],
    });

    expect(store.getSnapshot().data).toEqual([]);
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);

    execSync(db.insert(spacesTable, [{ id: "space-1", name: "First space" }]));

    expect(subscriber).toHaveBeenCalled();
    expect(store.getSnapshot().data).toEqual([
      { id: "space-1", name: "First space" },
    ]);

    unsubscribe();
    store.destroy();
  });

  it("collapses overlapping reruns and publishes the latest result", async () => {
    const tasksTable = defineTable("asyncStoreOverlapTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const db = createTestDB(tasksTable);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let runCount = 0;
    const projectTasks = selector({
      name: "asyncStoreOverlapProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        runCount++;
        const rows = yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );

        if (runCount === 1) {
          yield* unwrap(firstGate.promise);
        } else if (runCount === 2) {
          yield* unwrap(secondGate.promise);
        }

        return rows;
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      defaultValue: [],
    });
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);

    expect(store.getSnapshot().status).toBe("pending");

    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "First" },
      ]),
    );
    execSync(
      db.insert(tasksTable, [
        { id: "task-2", projectId: "project-1", title: "Second" },
      ]),
    );

    firstGate.resolve();
    await flushPromises();

    expect(runCount).toBe(2);
    expect(store.getSnapshot().status).toBe("pending");

    secondGate.resolve();
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [
          { id: "task-1", projectId: "project-1", title: "First" },
          { id: "task-2", projectId: "project-1", title: "Second" },
        ],
        status: "success",
      }),
    );
    expect(subscriber).toHaveBeenCalled();

    unsubscribe();
    store.destroy();
  });

  it("ignores late async results after destroy", async () => {
    const gate = deferred<string>();
    const db = createTestDB();
    const asyncValue = selector({
      name: "asyncStoreLateValue",
      args: {},
      *handler() {
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
    });
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    expect(store.getSnapshot().status).toBe("pending");
    store.destroy();
    gate.resolve("late");
    await flushPromises();

    expect(subscriber).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: "late" }),
    );
  });

  it("refetch resolves with a fresh result state", async () => {
    const tasksTable = defineTable("asyncStoreRefetchTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const db = createTestDB(tasksTable);
    const projectTasks = selector({
      name: "asyncStoreRefetchProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        return yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      initialData: [],
      subscribed: false,
    });

    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "Fresh" },
      ]),
    );
    const result = await store.refetch();

    expect(result).toEqual(
      expect.objectContaining({
        data: [{ id: "task-1", projectId: "project-1", title: "Fresh" }],
        status: "success",
      }),
    );

    store.destroy();
  });

  it("settles in-flight refetch when the last subscriber unsubscribes", async () => {
    const gate = deferred<string>();
    const db = createTestDB();
    const asyncValue = selector({
      name: "asyncStoreUnsubscribeRefetchValue",
      args: {},
      *handler() {
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
      subscribed: false,
    });
    const unsubscribe = store.subscribe(vi.fn());

    const refetchPromise = store.refetch();
    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        fetchStatus: "fetching",
        status: "pending",
      }),
    );

    unsubscribe();

    await expect(refetchPromise).resolves.toEqual(
      expect.objectContaining({
        fetchStatus: "idle",
        isFetching: false,
        status: "pending",
      }),
    );

    gate.resolve("late");
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: undefined,
        fetchStatus: "idle",
        status: "pending",
      }),
    );

    store.destroy();
  });

  it("settles in-flight refetch when the store is destroyed", async () => {
    const gate = deferred<string>();
    const db = createTestDB();
    const asyncValue = selector({
      name: "asyncStoreDestroyRefetchValue",
      args: {},
      *handler() {
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
      subscribed: false,
    });

    const refetchPromise = store.refetch();
    store.destroy();

    await expect(refetchPromise).resolves.toEqual(
      expect.objectContaining({
        fetchStatus: "idle",
        isFetching: false,
        status: "pending",
      }),
    );

    gate.resolve("late");
    await flushPromises();
  });

  it("reuses an in-flight subscribed run after unsubscribe and resubscribe", async () => {
    const first = deferred<string>();
    const db = createTestDB();
    let runCount = 0;
    const asyncValue = selector({
      name: "asyncStoreResubscribeInFlightValue",
      args: {},
      *handler() {
        runCount++;
        return yield* unwrap(first.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
    });
    const firstUnsubscribe = store.subscribe(vi.fn());

    expect(runCount).toBe(1);
    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        fetchStatus: "fetching",
        status: "pending",
      }),
    );

    firstUnsubscribe();
    const subscriber = vi.fn();
    const secondUnsubscribe = store.subscribe(subscriber);

    expect(runCount).toBe(1);

    first.resolve("fresh");
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: "fresh",
        fetchStatus: "idle",
        status: "success",
      }),
    );
    expect(subscriber).toHaveBeenCalled();

    secondUnsubscribe();
    store.destroy();
  });

  it("reuses an in-flight getSnapshot run after subscribe churn", async () => {
    const gate = deferred<string>();
    const db = createTestDB();
    let runCount = 0;
    const asyncValue = selector({
      name: "asyncStoreSnapshotStartedValue",
      args: {},
      *handler() {
        runCount++;
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: asyncValue,
      args: {},
    });

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: undefined,
        fetchStatus: "fetching",
        status: "pending",
      }),
    );
    expect(runCount).toBe(1);

    const firstUnsubscribe = store.subscribe(vi.fn());
    firstUnsubscribe();
    const subscriber = vi.fn();
    const secondUnsubscribe = store.subscribe(subscriber);

    expect(runCount).toBe(1);

    gate.resolve("fresh");
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: "fresh",
        fetchStatus: "idle",
        status: "success",
      }),
    );
    expect(subscriber).toHaveBeenCalled();

    secondUnsubscribe();
    store.destroy();
  });

  it("reruns a reused in-flight getSnapshot run after missed DB changes", async () => {
    const tasksTable = defineTable("asyncStoreSnapshotMissedTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const db = createTestDB(tasksTable);
    let runCount = 0;
    const projectTasks = selector({
      name: "asyncStoreSnapshotMissedProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        runCount++;
        const rows = yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );

        if (runCount === 1) {
          yield* unwrap(firstGate.promise);
        } else if (runCount === 2) {
          yield* unwrap(secondGate.promise);
        }

        return rows;
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [],
        fetchStatus: "fetching",
        status: "pending",
      }),
    );
    expect(runCount).toBe(1);

    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "Fresh" },
      ]),
    );
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);

    expect(runCount).toBe(1);

    firstGate.resolve();
    await flushPromises();

    expect(runCount).toBe(2);
    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [],
        fetchStatus: "fetching",
        status: "pending",
      }),
    );

    secondGate.resolve();
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [{ id: "task-1", projectId: "project-1", title: "Fresh" }],
        fetchStatus: "idle",
        status: "success",
      }),
    );
    expect(subscriber).toHaveBeenCalled();

    unsubscribe();
    store.destroy();
  });

  it("reruns a reused in-flight subscribed run after missed DB changes", async () => {
    const tasksTable = defineTable("asyncStoreResubscribeMissedTasks", {
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
    }).index("byProject", ["projectId"]);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const db = createTestDB(tasksTable);
    let runCount = 0;
    const projectTasks = selector({
      name: "asyncStoreResubscribeMissedProjectTasks",
      args: { projectId: v.string() },
      *handler({ projectId }) {
        runCount++;
        const rows = yield* selectFrom(tasksTable, "byProject").where((q) =>
          q.eq("projectId", projectId),
        );

        if (runCount === 1) {
          yield* unwrap(firstGate.promise);
        } else if (runCount === 2) {
          yield* unwrap(secondGate.promise);
        }

        return rows;
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: projectTasks,
      args: { projectId: "project-1" },
      defaultValue: [],
    });
    const firstUnsubscribe = store.subscribe(vi.fn());

    expect(runCount).toBe(1);

    firstUnsubscribe();
    execSync(
      db.insert(tasksTable, [
        { id: "task-1", projectId: "project-1", title: "Fresh" },
      ]),
    );
    const subscriber = vi.fn();
    const secondUnsubscribe = store.subscribe(subscriber);

    expect(runCount).toBe(1);

    firstGate.resolve();
    await flushPromises();

    expect(runCount).toBe(2);
    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [],
        fetchStatus: "fetching",
        status: "pending",
      }),
    );

    secondGate.resolve();
    await flushPromises();

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: [{ id: "task-1", projectId: "project-1", title: "Fresh" }],
        fetchStatus: "idle",
        status: "success",
      }),
    );
    expect(subscriber).toHaveBeenCalled();

    secondUnsubscribe();
    store.destroy();
  });

  it("refetch rejects selector errors when throwOnError is true", async () => {
    const error = new Error("selector failed");
    const db = createTestDB();
    const failingSelector = selector({
      name: "asyncStoreFailingSelector",
      args: {},
      *handler() {
        throw error;
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: failingSelector,
      args: {},
      subscribed: false,
    });

    await expect(store.refetch({ throwOnError: true })).rejects.toBe(error);
    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        error,
        status: "error",
      }),
    );

    store.destroy();
  });

  it("applies throwOnError for a refetch that joins an existing in-flight run", async () => {
    const gate = deferred<string>();
    const error = new Error("selector failed later");
    const db = createTestDB();
    const failingSelector = selector({
      name: "asyncStoreOverlappingFailingSelector",
      args: {},
      *handler() {
        return yield* unwrap(gate.promise);
      },
    });
    const store = createCachedSelectorStoreAsync(db, {
      selector: failingSelector,
      args: {},
      subscribed: false,
    });

    const nonThrowingRefetch = store.refetch();
    const throwingRefetch = store.refetch({ throwOnError: true });

    gate.reject(error);

    await expect(nonThrowingRefetch).resolves.toEqual(
      expect.objectContaining({
        error,
        status: "error",
      }),
    );
    await expect(throwingRefetch).rejects.toBe(error);

    store.destroy();
  });

  it("uses the cached maybe-async selector path for async stores", () => {
    const db = {
      getRevision: vi.fn(() => 0),
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as SubscribableDB;
    const cachedRunner = vi.fn((_db, input) => {
      input.selectRangeCmds.push({ table: "cached-range" });
      return "cached";
    });
    const store = createCachedSelectorStoreAsync(
      db,
      {
        selector: selector({
          name: "asyncStoreHybridSelector",
          args: {},
          *handler() {
            return "unused";
          },
        }),
        args: {},
      },
      {
        runCachedSelectorMaybeAsync: cachedRunner,
      },
    );

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: "cached",
        status: "success",
      }),
    );
    expect(cachedRunner).toHaveBeenCalledTimes(1);

    store.destroy();
  });

  it("uses the uncached maybe-async selector path for uncached async stores", () => {
    const db = {
      getRevision: vi.fn(() => 0),
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as SubscribableDB;
    const uncachedRunner = vi.fn((_db, input) => {
      input.selectRangeCmds.push({ table: "uncached-range" });
      return "uncached";
    });
    const store = createAsyncSelectorStore(
      db,
      {
        selector: selector({
          name: "asyncStoreUncachedSelector",
          args: {},
          *handler() {
            return "unused";
          },
        }),
        args: {},
      },
      {
        selectMaybeAsync: uncachedRunner,
      },
    );

    expect(store.getSnapshot()).toEqual(
      expect.objectContaining({
        data: "uncached",
        status: "success",
      }),
    );
    expect(uncachedRunner).toHaveBeenCalledTimes(1);

    store.destroy();
  });
});
