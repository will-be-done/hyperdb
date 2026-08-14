import { describe, expect, it, vi } from "vitest";
import { defineTable } from "../../schema/table";
import { execAsync } from "../../core/executor";
import { DB } from "../../runtime/db";
import { v } from "../../schema/values";
import {
  createInspectableSqlAsyncDriver,
  createSqlJsAsyncDriver,
} from "../../test-utils/sql-js-driver";
import { createTursoWasmDriver } from "../../test-utils/turso-wasm-driver";
import {
  AsyncSqlDriver,
  formatAsyncSqlDriverDebugEvent,
} from "./async-sql-driver";
import { SQLITE_SCHEMA_METADATA_TABLE } from "./sqlite-common";

type Task = {
  type: "task";
  id: string;
  title: string;
  state: "todo" | "done";
  lastToggledAt: number;
  projectId: string;
  orderToken: string;
};

const tasksTable = defineTable("tasks", {
  type: v.literal("task"),
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
  lastToggledAt: v.number(),
  projectId: v.string(),
  orderToken: v.string(),
})
  .index("ids", ["id"])
  .index("byTitle", ["title"], { type: "hash" })
  .index("projectIdState", ["projectId", "state", "lastToggledAt"]);

const uniqhashMigrationTableV1 = defineTable("asyncUniqhashMigration", {
  id: v.string(),
  email: v.string(),
}).index("byEmail", ["email"], { type: "hash" });

const uniqhashMigrationTableV2 = defineTable("asyncUniqhashMigration", {
  id: v.string(),
  email: v.string(),
}).index("byEmail", ["email"], { type: "uniqhash" });

const suffixNamedIndexTable = defineTable("asyncSuffixNamedIndex", {
  id: v.string(),
  title: v.string(),
})
  .index("byTitle_sort_key", ["title"])
  .index("uniqueTitle", ["title"], { type: "uniqhash" });

describe("db", async () => {
  it("releases the transaction lock when BEGIN fails", async () => {
    const statements: string[] = [];
    let failNextBegin = true;
    const driver = new AsyncSqlDriver({
      async exec(sql) {
        statements.push(sql);
        if (sql === "BEGIN TRANSACTION" && failNextBegin) {
          failNextBegin = false;
          throw new Error("temporary connection failure");
        }
      },
      prepare() {
        throw new Error("not used by this test");
      },
    });

    await expect(execAsync(driver.beginTx())).rejects.toThrow(
      "temporary connection failure",
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const transaction = await Promise.race([
      execAsync(driver.beginTx()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("transaction lock was not released")),
          100,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    await execAsync(transaction.rollback());

    expect(statements).toEqual([
      "BEGIN TRANSACTION",
      "BEGIN TRANSACTION",
      "ROLLBACK",
    ]);
  });

  it("uses one metadata read when async table schemas are unchanged", async () => {
    const { driver, execLog } = await createInspectableSqlAsyncDriver();
    const db = new DB(driver);

    await execAsync(db.loadTables([tasksTable]));
    execLog.length = 0;
    await execAsync(db.loadTables([tasksTable]));

    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toContain(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`);
    expect(execLog[0]).not.toContain("BEGIN TRANSACTION");
  });

  it("initializes async schema metadata when the adapter hides missing-table details", async () => {
    let obscureMetadataReadError = true;
    const { driver, sqldb, execLog } = await createInspectableSqlAsyncDriver(
      {},
      {
        beforePrepare(sql) {
          if (
            obscureMetadataReadError &&
            sql.includes(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`)
          ) {
            throw new Error("statement preparation failed");
          }
        },
      },
    );
    const db = new DB(driver);

    await execAsync(db.loadTables([tasksTable]));
    expect(
      sqldb.exec(
        `SELECT name FROM sqlite_schema WHERE name = '${SQLITE_SCHEMA_METADATA_TABLE}'`,
      )[0]?.values,
    ).toEqual([[SQLITE_SCHEMA_METADATA_TABLE]]);

    await expect(execAsync(db.loadTables([tasksTable]))).rejects.toThrow(
      "statement preparation failed",
    );

    obscureMetadataReadError = false;
    execLog.length = 0;
    await execAsync(db.loadTables([tasksTable]));
    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toContain(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`);
  });

  it("treats async SQLite index identifiers as case-insensitive", async () => {
    const { driver, sqldb, execLog } = await createInspectableSqlAsyncDriver();
    const db = new DB(driver);

    await execAsync(db.loadTables([tasksTable]));
    sqldb.exec("DROP INDEX idx_tasks_byTitle_sort_key_v2");
    sqldb.exec(
      "CREATE INDEX idx_tasks_bytitle_sort_key_v2 ON tasks(idx_byTitle_sort_key_v2, id) WHERE idx_byTitle_sort_key_v2 IS NOT NULL",
    );
    execLog.length = 0;

    await execAsync(db.loadTables([tasksTable]));

    expect(execLog.some((sql) => sql.startsWith("DROP INDEX"))).toBe(false);
    expect(
      (sqldb.exec("PRAGMA index_list(tasks)")[0]?.values ?? []).some(
        (row) => String(row[1]) === "idx_tasks_bytitle_sort_key_v2",
      ),
    ).toBe(true);
  });

  it("uses the schema metadata fast path with Turso WASM", async () => {
    const debug = vi.fn();
    const db = new DB(await createTursoWasmDriver({ debug }));

    await execAsync(db.loadTables([tasksTable]));
    debug.mockClear();
    await execAsync(db.loadTables([tasksTable]));

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toMatchObject({
      operation: "scan",
      status: "success",
    });
    expect(debug.mock.calls[0]?.[0].sql).toContain(
      `LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`,
    );
  });

  for (const driver of [createSqlJsAsyncDriver, createTursoWasmDriver]) {
    it("preserves physical indexes whose logical names end in _sort_key", async () => {
      const debug = vi.fn();
      const db = new DB(await driver({ debug }));
      await execAsync(db.loadTables([suffixNamedIndexTable]));
      await execAsync(
        db.insert(suffixNamedIndexTable, [
          { id: "task-b", title: "B" },
          { id: "task-a", title: "A" },
        ]),
      );
      debug.mockClear();

      await execAsync(db.loadTables([suffixNamedIndexTable]));

      expect(
        debug.mock.calls.some(([event]) =>
          event.normalizedSql.startsWith("DROP INDEX"),
        ),
      ).toBe(false);
      await expect(
        execAsync(
          db.intervalScan(suffixNamedIndexTable, "byTitle_sort_key", [{}]),
        ),
      ).resolves.toEqual([
        { id: "task-a", title: "A" },
        { id: "task-b", title: "B" },
      ]);
    });

    it("keeps SQL diagnostics silent by default", async () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      try {
        const db = new DB(await driver());

        await execAsync(db.loadTables([tasksTable]));
        await execAsync(
          db.insert(tasksTable, [
            {
              id: "task-1",
              title: "Task 1",
              state: "done",
              projectId: "1",
              orderToken: "b",
              type: "task",
              lastToggledAt: 0,
            },
          ]),
        );

        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("emits structured SQL diagnostics when debug is configured", async () => {
      const debug = vi.fn();
      const db = new DB(await driver({ debug }));

      await execAsync(db.loadTables([tasksTable]));
      await execAsync(
        db.insert(tasksTable, [
          {
            id: "task-1",
            title: "Task 1",
            state: "done",
            projectId: "1",
            orderToken: "b",
            type: "task",
            lastToggledAt: 0,
          },
        ]),
      );

      expect(
        debug.mock.calls.some(
          ([event]) =>
            event.operation === "insert" &&
            event.status === "success" &&
            event.tableName === "tasks" &&
            event.rowCount === 1,
        ),
      ).toBe(true);
      expect(
        debug.mock.calls.some(
          ([event]) =>
            event.operation === "exec" &&
            event.normalizedSql === "BEGIN TRANSACTION",
        ),
      ).toBe(true);
    });

    it("formats SQL diagnostics as one-line console messages", () => {
      expect(
        formatAsyncSqlDriverDebugEvent({
          operation: "scan",
          status: "success",
          sql: "SELECT data\nFROM tasks",
          normalizedSql: "SELECT data FROM tasks",
          durationMs: 3,
          rowCount: 2,
        }),
      ).toBe("SELECT data FROM tasks | 3ms | 2 rows");
      expect(
        formatAsyncSqlDriverDebugEvent({
          operation: "exec",
          status: "error",
          sql: "BEGIN TRANSACTION",
          normalizedSql: "BEGIN TRANSACTION",
          durationMs: 4,
        }),
      ).toBe("FAILED BEGIN TRANSACTION | 4ms");
    });

    it("works", async () => {
      const db = new DB(await driver());

      await execAsync(db.loadTables([tasksTable]));

      const updatedTask = (): Task => ({
        id: "task-1",
        title: "updated",
        state: "todo",
        projectId: "2",
        orderToken: "d",
        type: "task",
        lastToggledAt: 0,
      });

      const tasks: Task[] = [
        {
          id: "task-1",
          title: "Task 1",
          state: "done",
          projectId: "1",
          orderToken: "b",
          type: "task",
          lastToggledAt: 0,
        },
        {
          id: "task-2",
          title: "Task 2",
          state: "todo",
          projectId: "1",
          orderToken: "b",
          type: "task",
          lastToggledAt: 1,
        },
      ];
      await execAsync(db.insert(tasksTable, tasks));

      expect(
        await execAsync(
          db.intervalScan(tasksTable, "ids", [
            {
              eq: [{ col: "id", val: "task-1" }],
            },
          ]),
        ),
      ).toEqual([tasks[0]]);

      await execAsync(db.upsert(tasksTable, [updatedTask()]));

      expect(
        await execAsync(
          db.intervalScan(tasksTable, "ids", [
            {
              eq: [{ col: "id", val: "task-1" }],
            },
          ]),
        ),
      ).toEqual([updatedTask()]);

      await execAsync(db.delete(tasksTable, ["task-1"]));

      expect(
        await execAsync(
          db.intervalScan(tasksTable, "ids", [
            {
              eq: [{ col: "id", val: "task-1" }],
            },
          ]),
        ),
      ).toEqual([]);
    });

    it("backfills re-encoded sort keys before recreating indexes", async () => {
      const db = new DB(await driver());

      await execAsync(db.loadTables([uniqhashMigrationTableV1]));
      await execAsync(
        db.insert(uniqhashMigrationTableV1, [
          { id: "user-a", email: "a@example.com" },
          { id: "user-b", email: "b@example.com" },
        ]),
      );

      await execAsync(db.loadTables([uniqhashMigrationTableV2]));

      await expect(
        execAsync(
          db.intervalScan(uniqhashMigrationTableV2, "byEmail", [
            { eq: [{ col: "email", val: "a@example.com" }] },
          ]),
        ),
      ).resolves.toEqual([{ id: "user-a", email: "a@example.com" }]);
      await expect(
        execAsync(
          db.insert(uniqhashMigrationTableV2, [
            { id: "user-c", email: "a@example.com" },
          ]),
        ),
      ).rejects.toThrow();
    });
  }
});
