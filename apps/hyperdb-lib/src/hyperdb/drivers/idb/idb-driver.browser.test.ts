import { describe, expect, it, vi } from "vitest";
import {
  asyncDispatch,
  createAction,
  insert,
} from "../../commands/action/builders";
import { selectFrom } from "../../commands/selector/builder";
import { execAsync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import { DB } from "../../runtime/db";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { openIndexedDBDriver } from "./idb-driver";

const tasksTable = defineTable("idbTasks", {
  id: v.string(),
  title: v.string(),
  projectId: v.string(),
  rank: v.number(),
})
  .index("byTitle", ["title"], { type: "hash" })
  .index("byProjectRank", ["projectId", "rank"]);

const reloadTableV1 = defineTable("idbReload", {
  id: v.string(),
  title: v.string(),
});

const reloadTableV2 = defineTable("idbReload", {
  id: v.string(),
  title: v.string(),
}).index("byTitle", ["title"]);

const action = createAction();
let dbCounter = 0;

async function deleteDatabase(dbName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to delete test database"));
    request.onblocked = () =>
      reject(new Error("IndexedDB delete request was blocked"));
  });
}

async function createDB(): Promise<DB> {
  dbCounter += 1;
  const dbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
  await deleteDatabase(dbName);
  return new DB(await openIndexedDBDriver(dbName));
}

type GetAllRecordsHost = {
  getAllRecords: (options?: unknown) => IDBRequest<unknown>;
};

function spyOnGetAllRecords<T extends object>(prototype: T) {
  return "getAllRecords" in prototype
    ? vi.spyOn(prototype as T & GetAllRecordsHost, "getAllRecords")
    : undefined;
}

describe("IdbDriver", () => {
  it("stores rows in native per-table object stores", async () => {
    dbCounter += 1;
    const dbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(dbName);

    const driver = await openIndexedDBDriver(dbName);
    const db = new DB(driver);
    await execAsync(db.loadTables([tasksTable]));
    driver.close();

    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to inspect IDB database"));
    });

    try {
      expect(rawDb.objectStoreNames.contains("rows")).toBe(false);
      expect(rawDb.objectStoreNames.contains("indexEntries")).toBe(false);
      expect(rawDb.objectStoreNames.contains("hyperdb:idbTasks")).toBe(true);

      const tx = rawDb.transaction("hyperdb:idbTasks", "readonly");
      const store = tx.objectStore("hyperdb:idbTasks");
      expect(Array.from(store.indexNames).sort()).toEqual([
        "byId",
        "byProjectRank",
        "byTitle",
      ]);
    } finally {
      rawDb.close();
      await deleteDatabase(dbName);
    }
  });

  it("loads tables and supports insert, scan, upsert, and delete", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    const first = {
      id: "task-1",
      title: "First",
      projectId: "project-1",
      rank: 2,
    };
    const second = {
      id: "task-2",
      title: "Second",
      projectId: "project-1",
      rank: 1,
    };

    await execAsync(db.insert(tasksTable, [first, second]));

    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byProjectRank", [
          { eq: [{ col: "projectId", val: "project-1" }] },
        ]),
      ),
    ).toEqual([second, first]);

    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byTitle", [
          { eq: [{ col: "title", val: "First" }] },
        ]),
      ),
    ).toEqual([first]);

    const updated = { ...first, title: "Updated", rank: 3 };
    await execAsync(db.upsert(tasksTable, [updated]));

    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byProjectRank", [
          { eq: [{ col: "projectId", val: "project-1" }] },
        ]),
      ),
    ).toEqual([second, updated]);

    await execAsync(db.delete(tasksTable, ["task-2"]));
    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byProjectRank", [
          { eq: [{ col: "projectId", val: "project-1" }] },
        ]),
      ),
    ).toEqual([updated]);
  });

  it("logs transactions, writes, and indexed scans", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const db = await createDB();
      await execAsync(db.loadTables([tasksTable]));

      await execAsync(
        db.insert(tasksTable, [
          { id: "task-1", title: "First", projectId: "project-1", rank: 2 },
          { id: "task-2", title: "Second", projectId: "project-1", rank: 1 },
        ]),
      );
      await execAsync(
        db.intervalScan(tasksTable, "byProjectRank", [
          { eq: [{ col: "projectId", val: "project-1" }] },
        ]),
      );

      const messages = logSpy.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) =>
        /IDB transaction start .* mode readwrite/.test(message),
      )).toBe(true);
      expect(messages.some((message) =>
        /IDB transaction commit .* mode readwrite/.test(message),
      )).toBe(true);
      expect(messages.some((message) =>
        /IDB insert .* table idbTasks .* 2 rows/.test(message),
      )).toBe(true);
      expect(messages.some((message) =>
        /IDB scan .* table idbTasks .* using index byProjectRank .* 2 rows/.test(
          message,
        ),
      )).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uses batched covering reads for indexed scans", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    const first = {
      id: "task-1",
      title: "First",
      projectId: "project-1",
      rank: 2,
    };
    const second = {
      id: "task-2",
      title: "Second",
      projectId: "project-1",
      rank: 1,
    };
    await execAsync(db.insert(tasksTable, [first, second]));

    const getAllRecordsSpy = spyOnGetAllRecords(IDBIndex.prototype);
    const indexGetAllSpy = vi.spyOn(IDBIndex.prototype, "getAll");
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get");
    const storeOpenCursorSpy = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    const indexOpenCursorSpy = vi.spyOn(IDBIndex.prototype, "openCursor");

    try {
      await expect(
        execAsync(
          db.intervalScan(tasksTable, "byProjectRank", [
            { eq: [{ col: "projectId", val: "project-1" }] },
          ]),
        ),
      ).resolves.toEqual([second, first]);

      expect(
        (getAllRecordsSpy?.mock.calls.length ?? 0) + indexGetAllSpy.mock.calls.length,
      ).toBeGreaterThan(0);
      expect(getSpy).not.toHaveBeenCalled();
      expect(storeOpenCursorSpy).not.toHaveBeenCalled();
      expect(indexOpenCursorSpy).not.toHaveBeenCalled();
    } finally {
      getAllRecordsSpy?.mockRestore();
      indexGetAllSpy.mockRestore();
      getSpy.mockRestore();
      storeOpenCursorSpy.mockRestore();
      indexOpenCursorSpy.mockRestore();
    }
  });

  it("uses the table object store directly for full id-index scans", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    const first = {
      id: "task-1",
      title: "First",
      projectId: "project-1",
      rank: 2,
    };
    const second = {
      id: "task-2",
      title: "Second",
      projectId: "project-1",
      rank: 1,
    };
    await execAsync(db.insert(tasksTable, [second, first]));

    const storeGetAllRecordsSpy = spyOnGetAllRecords(IDBObjectStore.prototype);
    const storeGetAllSpy = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const indexGetAllRecordsSpy = spyOnGetAllRecords(IDBIndex.prototype);
    const indexGetAllSpy = vi.spyOn(IDBIndex.prototype, "getAll");

    try {
      await expect(
        execAsync(db.intervalScan(tasksTable, "byId", [{}])),
      ).resolves.toEqual([first, second]);

      expect(
        (storeGetAllRecordsSpy?.mock.calls.length ?? 0) +
          storeGetAllSpy.mock.calls.length,
      ).toBeGreaterThan(0);
      expect(indexGetAllRecordsSpy?.mock.calls.length ?? 0).toBe(0);
      expect(indexGetAllSpy).not.toHaveBeenCalled();
    } finally {
      storeGetAllRecordsSpy?.mockRestore();
      storeGetAllSpy.mockRestore();
      indexGetAllRecordsSpy?.mockRestore();
      indexGetAllSpy.mockRestore();
    }
  });

  it("uses primary-key get for exact id-index scans", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    const first = {
      id: "task-1",
      title: "First",
      projectId: "project-1",
      rank: 2,
    };
    const second = {
      id: "task-2",
      title: "Second",
      projectId: "project-1",
      rank: 1,
    };
    await execAsync(db.insert(tasksTable, [first, second]));

    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get");
    const indexGetAllSpy = vi.spyOn(IDBIndex.prototype, "getAll");

    try {
      await expect(
        execAsync(
          db.intervalScan(tasksTable, "byId", [
            { eq: [{ col: "id", val: "task-2" }] },
          ]),
        ),
      ).resolves.toEqual([second]);

      expect(getSpy).toHaveBeenCalledWith("task-2");
      expect(indexGetAllSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      indexGetAllSpy.mockRestore();
    }
  });

  it("rolls back duplicate insert batches without stale index entries", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    await execAsync(
      db.insert(tasksTable, [
        { id: "task-1", title: "Initial", projectId: "project-1", rank: 1 },
      ]),
    );

    await expect(
      execAsync(
        db.insert(tasksTable, [
          { id: "task-2", title: "Second", projectId: "project-1", rank: 2 },
          { id: "task-1", title: "Duplicate", projectId: "project-1", rank: 3 },
        ]),
      ),
    ).rejects.toThrow(/constraint|duplicate|exists/i);

    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byProjectRank", [
          { eq: [{ col: "projectId", val: "project-1" }] },
        ]),
      ),
    ).toEqual([
      { id: "task-1", title: "Initial", projectId: "project-1", rank: 1 },
    ]);
  });

  it("rebuilds index entries when loaded table definitions change", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([reloadTableV1]));
    await execAsync(db.insert(reloadTableV1, [{ id: "row-1", title: "A" }]));

    await execAsync(db.loadTables([reloadTableV2]));

    expect(
      await execAsync(
        db.intervalScan(reloadTableV2, "byTitle", [
          { eq: [{ col: "title", val: "A" }] },
        ]),
      ),
    ).toEqual([{ id: "row-1", title: "A" }]);
  });

  it("resets old side-table IDB layout", async () => {
    dbCounter += 1;
    const dbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(dbName);

    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("rows", { keyPath: ["tableName", "id"] });
        db.createObjectStore("indexEntries", {
          keyPath: ["tableName", "indexName", "sortKey", "id"],
        });
        db.createObjectStore("tableMetadata", { keyPath: "tableName" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to create old IDB layout"));
    });
    oldDb.close();

    const driver = await openIndexedDBDriver(dbName);
    const db = new DB(driver);
    await execAsync(db.loadTables([tasksTable]));

    expect(await execAsync(db.intervalScan(tasksTable, "byId", [{}]))).toEqual(
      [],
    );
    driver.close();

    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to inspect reset layout"));
    });

    try {
      expect(rawDb.objectStoreNames.contains("rows")).toBe(false);
      expect(rawDb.objectStoreNames.contains("indexEntries")).toBe(false);
      expect(rawDb.objectStoreNames.contains("hyperdb:idbTasks")).toBe(true);
    } finally {
      rawDb.close();
      await deleteDatabase(dbName);
    }
  });

  it("skips index rebuild when table definitions match after reopen", async () => {
    dbCounter += 1;
    const dbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(dbName);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let firstDriver: Awaited<ReturnType<typeof openIndexedDBDriver>> | undefined;
    let secondDriver:
      | Awaited<ReturnType<typeof openIndexedDBDriver>>
      | undefined;

    try {
      firstDriver = await openIndexedDBDriver(dbName);
      const firstDb = new DB(firstDriver);
      await execAsync(firstDb.loadTables([tasksTable]));
      const first = {
        id: "task-1",
        title: "First",
        projectId: "project-1",
        rank: 1,
      };
      await execAsync(firstDb.insert(tasksTable, [first]));
      firstDriver.close();

      logSpy.mockClear();

      secondDriver = await openIndexedDBDriver(dbName);
      const secondDb = new DB(secondDriver);
      await execAsync(secondDb.loadTables([tasksTable]));

      const messages = logSpy.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) =>
        /IDB rebuild indexes .* table idbTasks/.test(message),
      )).toBe(false);
      expect(
        await execAsync(
          secondDb.intervalScan(tasksTable, "byProjectRank", [
            { eq: [{ col: "projectId", val: "project-1" }] },
          ]),
        ),
      ).toEqual([first]);
    } finally {
      firstDriver?.close();
      secondDriver?.close();
      logSpy.mockRestore();
      await deleteDatabase(dbName);
    }
  });

  it("invalidates old connections when a newer IDB version opens", async () => {
    dbCounter += 1;
    const dbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(dbName);

    const versionChanges: IDBVersionChangeEvent[] = [];
    const oldDriver = await openIndexedDBDriver(dbName, {
      version: 1,
      onVersionChange: (event) => versionChanges.push(event),
    });
    const oldDb = new DB(oldDriver);
    await execAsync(oldDb.loadTables([reloadTableV1]));
    await execAsync(oldDb.insert(reloadTableV1, [{ id: "row-1", title: "A" }]));

    const newDriver = await openIndexedDBDriver(dbName, { version: 3 });
    const newDb = new DB(newDriver);
    await execAsync(newDb.loadTables([reloadTableV2]));

    expect(versionChanges).toHaveLength(1);
    await expect(
      execAsync(
        oldDb.upsert(reloadTableV1, [{ id: "row-1", title: "Stale" }]),
      ),
    ).rejects.toThrow(/stale.*reopen/i);

    await execAsync(
      newDb.upsert(reloadTableV2, [{ id: "row-1", title: "Fresh" }]),
    );

    expect(
      await execAsync(
        newDb.intervalScan(reloadTableV2, "byTitle", [
          { eq: [{ col: "title", val: "Fresh" }] },
        ]),
      ),
    ).toEqual([{ id: "row-1", title: "Fresh" }]);
  });

  it("supports generator-scoped commit and rollback transactions", async () => {
    const db = await createDB();
    await execAsync(db.loadTables([tasksTable]));

    function* rollbackProgram(target: HyperDB) {
      const tx = yield* target.beginTx();
      yield* tx.insert(tasksTable, [
        { id: "rollback", title: "Rollback", projectId: "project-1", rank: 1 },
      ]);
      yield* tx.rollback();
    }

    await execAsync(rollbackProgram(db));
    expect(
      await execAsync(
        db.intervalScan(tasksTable, "byTitle", [
          { eq: [{ col: "title", val: "Rollback" }] },
        ]),
      ),
    ).toEqual([]);

    const createTask = action({
      name: "idbCreateTask",
      args: {},
      handler: function* () {
        yield* insert(tasksTable, [
          { id: "commit", title: "Commit", projectId: "project-1", rank: 2 },
        ]);
        return yield* selectFrom(tasksTable, "byTitle").where((q) =>
          q.eq("title", "Commit"),
        );
      },
    });

    expect(await asyncDispatch(db, createTask({}))).toEqual([
      { id: "commit", title: "Commit", projectId: "project-1", rank: 2 },
    ]);
  });

  it("uses relaxed durability by default and allows overrides", async () => {
    dbCounter += 1;
    const relaxedDbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(relaxedDbName);
    dbCounter += 1;
    const strictDbName = `hyperdb-idb-driver-${Date.now().toString(36)}-${dbCounter}`;
    await deleteDatabase(strictDbName);

    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");

    try {
      const relaxedDb = new DB(await openIndexedDBDriver(relaxedDbName));
      await execAsync(relaxedDb.loadTables([tasksTable]));
      await execAsync(
        relaxedDb.insert(tasksTable, [
          { id: "task-1", title: "First", projectId: "project-1", rank: 1 },
        ]),
      );

      expect(
        txSpy.mock.calls.some(
          ([, mode, options]) =>
            mode === "readwrite" &&
            (options as IDBTransactionOptions | undefined)?.durability ===
              "relaxed",
        ),
      ).toBe(true);

      txSpy.mockClear();

      const strictDb = new DB(
        await openIndexedDBDriver(strictDbName, { durability: "strict" }),
      );
      await execAsync(strictDb.loadTables([tasksTable]));
      await execAsync(
        strictDb.insert(tasksTable, [
          { id: "task-1", title: "First", projectId: "project-1", rank: 1 },
        ]),
      );

      expect(
        txSpy.mock.calls.some(
          ([, mode, options]) =>
            mode === "readwrite" &&
            (options as IDBTransactionOptions | undefined)?.durability ===
              "strict",
        ),
      ).toBe(true);
    } finally {
      txSpy.mockRestore();
      await deleteDatabase(relaxedDbName);
      await deleteDatabase(strictDbName);
    }
  });
});
