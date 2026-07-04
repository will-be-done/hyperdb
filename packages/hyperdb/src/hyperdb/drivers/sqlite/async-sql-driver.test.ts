import { describe, expect, it, vi } from "vitest";
import { defineTable } from "../../schema/table";
import { execAsync } from "../../core/executor";
import { DB } from "../../runtime/db";
import { v } from "../../schema/values";
import { createSqlJsAsyncDriver } from "../../test-utils/sql-js-driver";
import { formatAsyncSqlDriverDebugEvent } from "./async-sql-driver";

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

describe("db", async () => {
  for (const driver of [createSqlJsAsyncDriver]) {
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
