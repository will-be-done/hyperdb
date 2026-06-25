import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB } from "./db";
import { HybridDB } from "./hybrid-db";
import { SubscribableDB } from "./subscribable-db";
import { AsyncDB } from "../test-utils/async-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { select, selectAsync } from "../commands/selector/selector";
import { selectFrom } from "../commands/selector/builder";
import { unwrap } from "../commands/async";
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
};

const tasksTable = defineTable("hybridTasks", {
  id: v.string(),
  title: v.string(),
  value: v.number(),
  projectId: v.string(),
})
  .index("byValue", ["value"])
  .index("byTitle", ["title"], { type: "hash" })
  .index("byProjectValue", ["projectId", "value"]);

const createTask = (value: number, title = `Task ${value}`): Task => ({
  id: String(value).padStart(3, "0"),
  title,
  value,
  projectId: value <= 3 ? "a" : "b",
});

const createDBs = async () => {
  const primary = new DB(new BptreeInmemDriver());
  const cache = new DB(new BptreeInmemDriver());
  const primaryScanSpy = vi.spyOn(primary, "intervalScan");
  const cacheScanSpy = vi.spyOn(cache, "intervalScan");
  const hybrid = new HybridDB(primary, cache);
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
  select(
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
      { ...createTask(1, "A"), id: "a" },
      { ...createTask(1, "B"), id: "b" },
      { ...createTask(1, "C"), id: "c" },
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
    vi.spyOn(primary, "intervalScan").mockImplementation(function* (
      table,
      indexName,
      clauses,
      selectOptions,
    ) {
      scanStarted.resolve();
      yield* unwrap(resumeScan.promise);
      return yield* originalPrimaryScan(table, indexName, clauses, selectOptions);
    });

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
    vi.spyOn(primary, "intervalScan").mockImplementation(function* (
      table,
      indexName,
      clauses,
      selectOptions,
    ) {
      scanStarted.resolve();
      yield* unwrap(resumeScan.promise);
      return yield* originalPrimaryScan(table, indexName, clauses, selectOptions);
    });

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
