import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB } from "./db";
import {
  HybridDB,
  HybridDBCrashedError,
  type HybridDBDebugEvent,
} from "./hybrid-db";
import { SubscribableDB } from "./subscribable-db";
import { AsyncDB } from "../test-utils/async-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import {
  createSelector,
  getSubscribableHybridCacheDB,
  createCachedSelectorStoreSync,
  preloadSelectorAsync,
  runCachedSelectorMaybeAsync,
  selectSync,
  selectAsync,
} from "../commands/selector/selector";
import { selectFrom } from "../commands/selector/builder";
import { unwrap } from "../commands/async";
import { execAsync } from "../core/executor";
import {
  hyperDBTraceStore,
  traceRootsRuntimeTable,
  type RootTrace,
  type SelectScanSource,
} from "../tracing";

type Task = {
  id: string;
  title: string;
  value: number;
  projectId: string;
  slug: string;
};

const tasksTable = defineTable("hybridTasks", {
  id: v.string(),
  title: v.string(),
  value: v.number(),
  projectId: v.string(),
  slug: v.string(),
})
  .index("byValue", ["value"])
  .index("byIds", ["id"])
  .index("byTitle", ["title"], { type: "hash" })
  .index("bySlug", ["slug"], { type: "uniqhash" })
  .index("byProjectValue", ["projectId", "value"]);

const createTask = (value: number, title = `Task ${value}`): Task => ({
  id: String(value).padStart(3, "0"),
  title,
  value,
  projectId: value <= 3 ? "a" : "b",
  slug: `task-${value}`,
});

const createDBs = async (
  hybridOptions?: ConstructorParameters<typeof HybridDB>[2],
) => {
  const primary = new DB(new BptreeInmemDriver());
  const cache = new DB(new BptreeInmemDriver());
  const primaryScanSpy = vi.spyOn(primary, "intervalScan");
  const cacheScanSpy = vi.spyOn(cache, "intervalScan");
  const hybrid = new HybridDB(primary, cache, hybridOptions);
  const db = new AsyncDB(hybrid);

  await db.loadTables([tasksTable]);

  return { db, hybrid, primary, cache, primaryScanSpy, cacheScanSpy };
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const waitOneTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

const selectCommittedTraces = (limit = 20): RootTrace[] =>
  selectSync(
    hyperDBTraceStore.getDB(),
    (function* () {
      const rows = yield* selectFrom(traceRootsRuntimeTable, "byCreatedSeq")
        .order("desc")
        .limit(limit);
      return hyperDBTraceStore.resolveTraceRows(rows);
    })(),
  );

let deactivateTraceStore: (() => void) | undefined;

const lastSelectSource = (): SelectScanSource | undefined => {
  hyperDBTraceStore.flushTraceCommits();
  return selectCommittedTraces()[0]?.commandEvents[0]?.source;
};

const selectByValue = (
  minValue: number,
  maxValue?: number,
  limit?: number,
): Generator<unknown, Task[], unknown> =>
  (function* () {
    let query = selectFrom(tasksTable, "byValue").where((q) => {
      const minQuery = q.gte("value", minValue);
      return maxValue === undefined
        ? minQuery
        : minQuery.lte("value", maxValue);
    });

    if (limit !== undefined) {
      query = query.limit(limit);
    }

    return yield* query;
  })();

describe("HybridDB", () => {
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

  it("loads range misses from primary and serves repeated reads from cache", async () => {
    const { db, primary, primaryScanSpy, cacheScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const first = await db.intervalScan(tasksTable, "byValue", [
      { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
    ]);
    expect(first).toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    cacheScanSpy.mockClear();

    const second = await db.intervalScan(tasksTable, "byValue", [
      { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
    ]);
    expect(second).toEqual(tasks);
    expect(primaryScanSpy).not.toHaveBeenCalled();
    expect(cacheScanSpy).toHaveBeenCalledTimes(1);
  });

  it("caches limited btree reads up to the unique returned row", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = Array.from({ length: 6 }, (_, index) =>
      createTask(index + 1),
    );
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(
        tasksTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }] }],
        { limit: 2 },
      ),
    ).resolves.toEqual(tasks.slice(0, 2));
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(
        tasksTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }] }],
        { limit: 2 },
      ),
    ).resolves.toEqual(tasks.slice(0, 2));
    expect(primaryScanSpy).not.toHaveBeenCalled();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 3 }], lte: [{ col: "value", val: 3 }] },
      ]),
    ).resolves.toEqual([tasks[2]]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });

  it("records persist for the first traced HybridDB scan", async () => {
    const { hybrid, primary } = await createDBs();
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(selectAsync(hybrid, selectByValue(1, 3))).resolves.toEqual(
      tasks,
    );

    expect(lastSelectSource()).toBe("persist");
  });

  it("records in-mem for repeated traced HybridDB scans served from cache", async () => {
    const { hybrid, primary } = await createDBs();
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await selectAsync(hybrid, selectByValue(1, 3));
    hyperDBTraceStore.clear();

    await expect(selectAsync(hybrid, selectByValue(1, 3))).resolves.toEqual(
      tasks,
    );

    expect(lastSelectSource()).toBe("in-mem");
  });

  it("makes HybridDB selector results available to direct in-memory cache reads", async () => {
    const { hybrid, primary, cache, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(selectAsync(hybrid, selectByValue(1, 3))).resolves.toEqual(
      tasks,
    );
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();

    expect(selectSync(cache, selectByValue(1, 3))).toEqual(tasks);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("records HybridDB root selector reuse as cached", async () => {
    const { hybrid, primary } = await createDBs();
    const db = new SubscribableDB(hybrid);
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);
    const selector = createSelector();
    const projectTasks = selector({
      name: "cachedHybridProjectTasks",
      args: { projectId: v.string() },
      handler: function* cachedHybridProjectTasks({ projectId }) {
        return yield* selectFrom(tasksTable, "byProjectValue")
          .where((q) => q.eq("projectId", projectId))
          .order("asc");
      },
    });

    await expect(
      Promise.resolve(
        runCachedSelectorMaybeAsync(db, projectTasks, { projectId: "a" }),
      ),
    ).resolves.toEqual(tasks);
    hyperDBTraceStore.clear();

    await expect(
      Promise.resolve(
        runCachedSelectorMaybeAsync(db, projectTasks, { projectId: "a" }),
      ),
    ).resolves.toEqual(tasks);

    hyperDBTraceStore.flushTraceCommits();
    const trace = selectCommittedTraces()[0]!;
    expect(trace.name).toBe("cachedHybridProjectTasks");
    expect(trace.frames[0]?.cached).toBe(true);
  });

  it("primes the in-memory selector cache when preloading a HybridDB selector", async () => {
    const { hybrid, primary } = await createDBs();
    const db = new SubscribableDB(hybrid);
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);
    const selector = createSelector();
    let runCount = 0;
    const projectTasks = selector({
      name: "preloadedHybridProjectTasks",
      args: { projectId: v.string() },
      handler: function* preloadedHybridProjectTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(tasksTable, "byProjectValue")
          .where((q) => q.eq("projectId", projectId))
          .order("asc");
      },
    });

    await expect(
      preloadSelectorAsync(db, projectTasks, { projectId: "a" }),
    ).resolves.toEqual(tasks);
    expect(runCount).toBe(1);

    const cacheDB = getSubscribableHybridCacheDB(db);
    expect(cacheDB).toBeDefined();
    const cached = createCachedSelectorStoreSync(cacheDB!, projectTasks, {
      projectId: "a",
    });

    expect(cached.getSnapshot()).toEqual(tasks);
    expect(runCount).toBe(1);
  });

  it("reuses HybridDB root selector cache on repeated selector preloads", async () => {
    const { hybrid, primary } = await createDBs();
    const db = new SubscribableDB(hybrid);
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);
    const selector = createSelector();
    let runCount = 0;
    const projectTasks = selector({
      name: "reusedPreloadedHybridProjectTasks",
      args: { projectId: v.string() },
      handler: function* reusedPreloadedHybridProjectTasks({ projectId }) {
        runCount++;
        return yield* selectFrom(tasksTable, "byProjectValue")
          .where((q) => q.eq("projectId", projectId))
          .order("asc");
      },
    });

    await expect(
      preloadSelectorAsync(db, projectTasks, { projectId: "a" }),
    ).resolves.toEqual(tasks);
    expect(runCount).toBe(1);

    await expect(
      preloadSelectorAsync(db, projectTasks, { projectId: "a" }),
    ).resolves.toEqual(tasks);

    expect(runCount).toBe(1);
  });

  it("preloads whole tables and serves other indexes from cache", async () => {
    const { db, hybrid, primary, primaryScanSpy } = await createDBs();
    const subscribable = new SubscribableDB(hybrid);
    const tasks = [
      createTask(1, "same"),
      createTask(2, "same"),
      createTask(3, "other"),
      createTask(4, "other"),
    ];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await execAsync(
      subscribable.preloadTables([{ table: tasksTable, scanIndex: "byIds" }]),
    );
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byProjectValue", [
        { eq: [{ col: "projectId", val: "a" }] },
      ]),
    ).resolves.toEqual(tasks.slice(0, 3));
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(tasks.slice(0, 2));
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("requires a btree scan index for whole-table preloads", async () => {
    const { hybrid } = await createDBs();

    await expect(
      execAsync(
        hybrid.preloadTables([{ table: tasksTable, scanIndex: "byId" }]),
      ),
    ).rejects.toThrow(
      "HybridDB preload scan index must be a btree index: byId for table: hybridTasks",
    );
  });

  it("throws for preloadTables inside HybridDB transactions", async () => {
    const { hybrid } = await createDBs();
    const writeTx = await execAsync(hybrid.beginTx());
    try {
      await expect(
        execAsync(
          writeTx.preloadTables([{ table: tasksTable, scanIndex: "byIds" }]),
        ),
      ).rejects.toThrow(
        "preloadTables is not supported inside HybridDB transactions",
      );
    } finally {
      await execAsync(writeTx.rollback());
    }

    const readonlyTx = await execAsync(hybrid.beginTx("readonly"));
    try {
      await expect(
        execAsync(
          readonlyTx.preloadTables([{ table: tasksTable, scanIndex: "byIds" }]),
        ),
      ).rejects.toThrow(
        "preloadTables is not supported inside HybridDB transactions",
      );
    } finally {
      await execAsync(readonlyTx.rollback());
    }

    const subscribable = new SubscribableDB(hybrid);
    const subscribableTx = await execAsync(subscribable.beginTx());
    try {
      await expect(
        execAsync(
          subscribableTx.preloadTables([
            { table: tasksTable, scanIndex: "byIds" },
          ]),
        ),
      ).rejects.toThrow(
        "preloadTables is not supported inside HybridDB transactions",
      );
    } finally {
      await execAsync(subscribableTx.rollback());
    }
  });

  it("allows direct cache selector reads while a HybridDB write transaction is active", async () => {
    const { db, cache } = await createDBs();
    const original = createTask(1);
    const updated = { ...original, value: 2, title: "updated" };
    await db.insert(tasksTable, [original]);

    const tx = await db.beginTx();
    await tx.upsert(tasksTable, [updated]);

    expect(selectSync(cache, selectByValue(1, 1))).toEqual([original]);
    expect(selectSync(cache, selectByValue(2, 2))).toEqual([]);
    await expect(
      tx.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual([updated]);

    await tx.commit();

    expect(selectSync(cache, selectByValue(1, 1))).toEqual([]);
    expect(selectSync(cache, selectByValue(2, 2))).toEqual([updated]);
  });

  it("commits cache writes before persistence and blocks intersecting uncached reads", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, primary, cache } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const original = createTask(1);
    const updated = { ...original, value: 2, title: "updated" };
    await db.insert(tasksTable, [original]);

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([original]);

    const persistCommitStarted = deferred();
    const resumePersistCommit = deferred();
    const originalBeginTx = primary.beginTx.bind(primary);
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      const tx = yield* originalBeginTx(mode);
      if (mode === "readwrite" || mode === undefined) {
        const originalCommit = tx.commit.bind(tx);
        vi.spyOn(tx, "commit").mockImplementation(function* () {
          persistCommitStarted.resolve();
          yield* unwrap(resumePersistCommit.promise);
          return yield* originalCommit();
        });
      }
      return tx;
    });

    const tx = await db.beginTx();
    await tx.upsert(tasksTable, [updated]);
    await tx.commit();
    await waitOneTurn();
    await expect(persistCommitStarted.promise).resolves.toBeUndefined();

    expect(selectSync(cache, selectByValue(1, 1))).toEqual([]);
    expect(selectSync(cache, selectByValue(2, 2))).toEqual([updated]);
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([]);

    let uncachedReadResolved = false;
    const uncachedRead = db
      .intervalScan(tasksTable, "byValue", [{ eq: [{ col: "value", val: 2 }] }])
      .then((rows) => {
        uncachedReadResolved = true;
        return rows;
      });
    await waitOneTurn();
    expect(uncachedReadResolved).toBe(false);
    expect(
      debugEvents.filter((event) => event.type === "pending-persistence-wait"),
    ).toEqual([
      {
        type: "pending-persistence-wait",
        tableName: tasksTable.tableName,
        indexName: "byValue",
        clauses: [{ eq: [{ col: "value", val: 2 }] }],
        selectOptions: undefined,
        reasons: [
          {
            batchId: 1,
            tableName: tasksTable.tableName,
            rowId: updated.id,
            oldValueKnown: true,
            oldValueMatches: false,
            newValueMatches: true,
          },
        ],
      },
    ]);
    expect(debugEvents.some((event) => event.type === "persistent-scan")).toBe(
      true,
    );

    resumePersistCommit.resolve();
    await expect(uncachedRead).resolves.toEqual([updated]);
  });

  it("serves exact id lookups from cache while persistence is pending", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, primary } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const original = createTask(1);
    const updated = { ...original, value: 2, title: "updated" };
    await db.insert(tasksTable, [original]);

    const persistCommitStarted = deferred();
    const resumePersistCommit = deferred();
    const originalBeginTx = primary.beginTx.bind(primary);
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      const tx = yield* originalBeginTx(mode);
      if (mode === "readwrite" || mode === undefined) {
        const originalCommit = tx.commit.bind(tx);
        vi.spyOn(tx, "commit").mockImplementation(function* () {
          persistCommitStarted.resolve();
          yield* unwrap(resumePersistCommit.promise);
          return yield* originalCommit();
        });
      }
      return tx;
    });

    const tx = await db.beginTx();
    await tx.upsert(tasksTable, [updated]);
    await tx.commit();
    await waitOneTurn();
    await expect(persistCommitStarted.promise).resolves.toBeUndefined();

    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: updated.id }] },
      ]),
    ).resolves.toEqual([updated]);
    expect(debugEvents).toEqual([]);

    resumePersistCommit.resolve();
  });

  it("serves deleted id lookups from cache but waits for unknown unique values", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, primary } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const original = createTask(1);
    await new AsyncDB(primary).insert(tasksTable, [original]);

    const persistCommitStarted = deferred();
    const resumePersistCommit = deferred();
    const originalBeginTx = primary.beginTx.bind(primary);
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      const tx = yield* originalBeginTx(mode);
      if (mode === "readwrite" || mode === undefined) {
        const originalCommit = tx.commit.bind(tx);
        vi.spyOn(tx, "commit").mockImplementation(function* () {
          persistCommitStarted.resolve();
          yield* unwrap(resumePersistCommit.promise);
          return yield* originalCommit();
        });
      }
      return tx;
    });

    const tx = await db.beginTx();
    await tx.delete(tasksTable, [original.id]);
    await tx.commit();
    await waitOneTurn();
    await expect(persistCommitStarted.promise).resolves.toBeUndefined();

    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: original.id }] },
      ]),
    ).resolves.toEqual([]);

    let slugReadResolved = false;
    const slugRead = db
      .intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: original.slug }] },
      ])
      .then((rows) => {
        slugReadResolved = true;
        return rows;
      });
    await waitOneTurn();
    expect(slugReadResolved).toBe(false);
    expect(
      debugEvents.filter((event) => event.type === "pending-persistence-wait"),
    ).toEqual([
      {
        type: "pending-persistence-wait",
        tableName: tasksTable.tableName,
        indexName: "bySlug",
        clauses: [{ eq: [{ col: "slug", val: original.slug }] }],
        selectOptions: undefined,
        reasons: [
          {
            batchId: 1,
            tableName: tasksTable.tableName,
            rowId: original.id,
            oldValueKnown: false,
            oldValueMatches: false,
            newValueMatches: false,
          },
        ],
      },
    ]);

    resumePersistCommit.resolve();
    await expect(slugRead).resolves.toEqual([]);
  });

  it("retries background persistence failures and crashes the DB after exhausting retries", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, hybrid, primary } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const persistenceError = new Error("primary unavailable");
    const originalBeginTx = primary.beginTx.bind(primary);
    let persistAttempts = 0;
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      if (mode === "readwrite" || mode === undefined) {
        persistAttempts++;
        throw persistenceError;
      }
      return yield* originalBeginTx(mode);
    });

    const inserted = createTask(1);
    const tx = await db.beginTx();
    await tx.insert(tasksTable, [inserted]);
    await tx.commit();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: inserted.value }] },
      ]),
    ).rejects.toThrow(HybridDBCrashedError);
    expect(persistAttempts).toBe(3);
    expect(hybrid.isCrashed).toBe(true);

    const persistenceFailureEvents = debugEvents.filter(
      (event) => event.type === "persistence-failure",
    );
    expect(persistenceFailureEvents).toEqual([
      {
        type: "persistence-failure",
        batchId: 1,
        writeCount: 1,
        error: persistenceError,
        attempt: 1,
        maxAttempts: 3,
        retryDelayMs: 10,
        willRetry: true,
      },
      {
        type: "persistence-failure",
        batchId: 1,
        writeCount: 1,
        error: persistenceError,
        attempt: 2,
        maxAttempts: 3,
        retryDelayMs: 20,
        willRetry: true,
      },
      {
        type: "persistence-failure",
        batchId: 1,
        writeCount: 1,
        error: persistenceError,
        attempt: 3,
        maxAttempts: 3,
        retryDelayMs: undefined,
        willRetry: false,
      },
    ]);
    expect(
      debugEvents.some((event) => event.type === "pending-persistence-wait"),
    ).toBe(true);

    // Once crashed, every further read/write throws and no new persistence is
    // attempted, even for cache-only operations.
    await expect(db.insert(tasksTable, [createTask(2)])).rejects.toThrow(
      HybridDBCrashedError,
    );
    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: inserted.id }] },
      ]),
    ).rejects.toThrow(HybridDBCrashedError);
    await expect(db.beginTx()).rejects.toThrow(HybridDBCrashedError);
    expect(persistAttempts).toBe(3);
  });

  it("does not run queued persistence after the DB has crashed", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, hybrid, primary } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const persistenceError = new Error("primary unavailable");
    const originalBeginTx = primary.beginTx.bind(primary);
    let persistAttempts = 0;
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      if (mode === "readwrite" || mode === undefined) {
        persistAttempts++;
        throw persistenceError;
      }
      return yield* originalBeginTx(mode);
    });

    const firstTx = await db.beginTx();
    await firstTx.insert(tasksTable, [createTask(1)]);
    await firstTx.commit();

    const secondTx = await db.beginTx();
    await secondTx.insert(tasksTable, [createTask(2)]);
    await secondTx.commit();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 2 }] },
      ]),
    ).rejects.toThrow(HybridDBCrashedError);

    expect(hybrid.isCrashed).toBe(true);
    expect(persistAttempts).toBe(3);
    expect(
      debugEvents
        .filter((event) => event.type === "persistence-failure")
        .map((event) => event.batchId),
    ).toEqual([1, 1, 1]);
  });

  it("uses parent cache coverage for exact id reads inside write transactions", async () => {
    const debugEvents: HybridDBDebugEvent[] = [];
    const { db, primaryScanSpy } = await createDBs({
      debug: (event) => debugEvents.push(event),
    });
    const task = createTask(1);
    await db.insert(tasksTable, [task]);

    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: task.id }] },
      ]),
    ).resolves.toEqual([task]);

    primaryScanSpy.mockClear();
    debugEvents.length = 0;
    const tx = await db.beginTx();
    await expect(
      tx.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: task.id }] },
      ]),
    ).resolves.toEqual([task]);
    await tx.rollback();

    expect(primaryScanSpy).not.toHaveBeenCalled();
    expect(debugEvents).toEqual([]);
  });

  it("records sources through SubscribableDB-wrapped HybridDB scans", async () => {
    const { hybrid, primary } = await createDBs();
    const db = new SubscribableDB(hybrid);
    const tasks = [createTask(1), createTask(2), createTask(3)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(selectAsync(db, selectByValue(1, 3))).resolves.toEqual(tasks);

    expect(lastSelectSource()).toBe("persist");
  });

  it("records persist when a limited cache probe falls back to primary", async () => {
    const { hybrid, primary } = await createDBs();
    const tasks = Array.from({ length: 4 }, (_, index) =>
      createTask(index + 1),
    );
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await selectAsync(hybrid, selectByValue(1, undefined, 2));
    hyperDBTraceStore.clear();

    await expect(
      selectAsync(hybrid, selectByValue(1, undefined, 3)),
    ).resolves.toEqual(tasks.slice(0, 3));

    expect(lastSelectSource()).toBe("persist");
  });

  it("does not record a scan source for limit 0 traced HybridDB scans", async () => {
    const { hybrid, primary } = await createDBs();
    await new AsyncDB(primary).insert(tasksTable, [createTask(1)]);

    await expect(
      selectAsync(hybrid, selectByValue(1, undefined, 0)),
    ).resolves.toEqual([]);

    expect(lastSelectSource()).toBeUndefined();
  });

  it("uses the appended id cursor for limited duplicate btree values", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks: Task[] = [
      { ...createTask(1, "A"), id: "a", slug: "task-a" },
      { ...createTask(1, "B"), id: "b", slug: "task-b" },
      { ...createTask(1, "C"), id: "c", slug: "task-c" },
    ];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(
        tasksTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 1 }] }],
        { limit: 2 },
      ),
    ).resolves.toEqual(tasks.slice(0, 2));

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(
        tasksTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 1 }] }],
        { limit: 2 },
      ),
    ).resolves.toEqual(tasks.slice(0, 2));
    expect(primaryScanSpy).not.toHaveBeenCalled();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });

  it("serves hash equality lookups from cache after the first read", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1, "same"), createTask(2, "same")];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("marks uniqhash values covered when rows are loaded through another index", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: "task-1" }] },
      ]),
    ).resolves.toEqual([tasks[0]]);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("does not mark non-unique hash buckets covered when rows are loaded through another index", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1, "same"), createTask(2, "same")];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });

  it("does not mark a limited non-id hash lookup as fully cached", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1, "same"), createTask(2, "same")];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    await expect(
      db.intervalScan(
        tasksTable,
        "byTitle",
        [{ eq: [{ col: "title", val: "same" }] }],
        { limit: 1 },
      ),
    ).resolves.toEqual([tasks[0]]);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });

  it("serializes read miss cache fill against transactions", async () => {
    const { db, primary } = await createDBs();
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const scanStarted = deferred();
    const resumeScan = deferred();
    const originalPrimaryScan = DB.prototype.intervalScan.bind(primary);
    vi.spyOn(primary, "intervalScan").mockImplementation(
      function* (table, indexName, clauses, selectOptions) {
        scanStarted.resolve();
        yield* unwrap(resumeScan.promise);
        return yield* originalPrimaryScan(
          table,
          indexName,
          clauses,
          selectOptions,
        );
      },
    );

    const readPromise = db.intervalScan(tasksTable, "byValue", [
      { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
    ]);
    await scanStarted.promise;

    let txResolved = false;
    const txPromise = db.beginTx().then((tx) => {
      txResolved = true;
      return tx;
    });
    await waitOneTurn();
    expect(txResolved).toBe(false);

    resumeScan.resolve();
    await expect(readPromise).resolves.toEqual(tasks);

    const tx = await txPromise;
    expect(txResolved).toBe(true);
    await tx.rollback();
  });

  it("shares the concurrency lock across withTraits wrappers", async () => {
    const { hybrid, primary } = await createDBs();
    const db = new AsyncDB(hybrid);
    const traitedDb = new AsyncDB(hybrid.withTraits({ type: "traited" }));
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const scanStarted = deferred();
    const resumeScan = deferred();
    const originalPrimaryScan = DB.prototype.intervalScan.bind(primary);
    vi.spyOn(primary, "intervalScan").mockImplementation(
      function* (table, indexName, clauses, selectOptions) {
        scanStarted.resolve();
        yield* unwrap(resumeScan.promise);
        return yield* originalPrimaryScan(
          table,
          indexName,
          clauses,
          selectOptions,
        );
      },
    );

    const readPromise = traitedDb.intervalScan(tasksTable, "byValue", [
      { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
    ]);
    await scanStarted.promise;

    let txResolved = false;
    const txPromise = db.beginTx().then((tx) => {
      txResolved = true;
      return tx;
    });
    await waitOneTurn();
    expect(txResolved).toBe(false);

    resumeScan.resolve();
    await expect(readPromise).resolves.toEqual(tasks);

    const tx = await txPromise;
    expect(txResolved).toBe(true);
    await tx.rollback();
  });

  it("writes through to primary and cache synchronously", async () => {
    const { db, primary, cache } = await createDBs();
    const task = createTask(1);

    await db.insert(tasksTable, [task]);
    await expect(
      new AsyncDB(primary).intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([task]);
    await expect(
      new AsyncDB(cache).intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([task]);

    const updated = { ...task, title: "updated" };
    await db.upsert(tasksTable, [updated]);
    await expect(
      new AsyncDB(primary).intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "updated" }] },
      ]),
    ).resolves.toEqual([updated]);
    await expect(
      new AsyncDB(cache).intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "updated" }] },
      ]),
    ).resolves.toEqual([updated]);

    await db.delete(tasksTable, [task.id]);
    await expect(
      new AsyncDB(primary).intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([]);
    await expect(
      new AsyncDB(cache).intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([]);
  });

  it("keeps transaction reads and writes consistent before commit", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const tx = await db.beginTx();
    await expect(
      tx.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);

    const inserted = createTask(3);
    await tx.insert(tasksTable, [inserted]);
    await expect(
      tx.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
      ]),
    ).resolves.toEqual([...tasks, inserted]);

    await tx.commit();
    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("reuses transaction scan coverage after returning cache with pending writes", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const tx = await db.beginTx();
    const inserted = createTask(3);
    await tx.insert(tasksTable, [inserted]);
    const clauses = [
      { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
    ];

    primaryScanSpy.mockClear();
    await expect(
      tx.intervalScan(tasksTable, "byValue", clauses),
    ).resolves.toEqual([...tasks, inserted]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      tx.intervalScan(tasksTable, "byValue", clauses),
    ).resolves.toEqual([...tasks, inserted]);
    expect(primaryScanSpy).not.toHaveBeenCalled();

    await tx.rollback();
  });

  it("publishes uniqhash coverage from committed cache transactions", async () => {
    const { db, primaryScanSpy } = await createDBs();
    const inserted = createTask(1);

    const tx = await db.beginTx();
    await tx.insert(tasksTable, [inserted]);
    await tx.commit();

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: inserted.slug }] },
      ]),
    ).resolves.toEqual([inserted]);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("does not publish transaction cache coverage on rollback", async () => {
    const { db, primary, primaryScanSpy } = await createDBs();
    const tasks = [createTask(1), createTask(2)];
    await new AsyncDB(primary).insert(tasksTable, tasks);

    const tx = await db.beginTx();
    await expect(
      tx.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);
    await tx.rollback();

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(tasks);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });
});
