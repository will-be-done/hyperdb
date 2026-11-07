import { describe, expect, it } from "vitest";
import {
  deleteTestIndexedDB,
  uniqueTestDBName,
} from "../../test-utils/indexeddb";
import { execAsync } from "../../core/executor";
import { DB } from "../../runtime/db";
import { PreloadedHybridDB } from "../../runtime/preloaded-hybrid-db";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { openIndexedDBDriver } from "./idb-driver";

const bulkRowsTable = defineTable("idbScanAllBulkRows", {
  id: v.string(),
  value: v.number(),
});

const bulkGroupsTable = defineTable("idbScanAllBulkGroups", {
  id: v.string(),
  title: v.string(),
});

const deleteDatabase = deleteTestIndexedDB;

describe("IdbDriver scanAll", () => {
  it("reads at least 1,001 decoded rows in key order", async () => {
    const databaseName = uniqueTestDBName("hyperdb-idb-scan-all");
    await deleteDatabase(databaseName);
    const driver = await openIndexedDBDriver(databaseName);
    const db = new DB(driver);
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      id: `row-${String(index).padStart(4, "0")}`,
      value: index,
    }));

    try {
      await execAsync(db.loadTables([bulkRowsTable]));
      await execAsync(db.insert(bulkRowsTable, rows));

      await expect(execAsync(db.scanAll(bulkRowsTable))).resolves.toEqual(rows);
    } finally {
      driver.close();
      await deleteDatabase(databaseName);
    }
  });

  it("preloads multiple IndexedDB tables with whole concurrency", async () => {
    const databaseName = uniqueTestDBName("hyperdb-idb-preloaded");
    await deleteDatabase(databaseName);
    const driver = await openIndexedDBDriver(databaseName);
    const primary = new DB(driver);
    const row = { id: "row-1", value: 1 };
    const group = { id: "group-1", title: "Group" };

    try {
      await execAsync(primary.loadTables([bulkRowsTable, bulkGroupsTable]));
      await execAsync(primary.insert(bulkRowsTable, [row]));
      await execAsync(primary.insert(bulkGroupsTable, [group]));

      const preloaded = new PreloadedHybridDB(primary, {
        preloadConcurrency: "whole",
      });
      await execAsync(preloaded.loadTables([bulkRowsTable, bulkGroupsTable]));

      await expect(
        execAsync(
          preloaded.intervalScan(bulkRowsTable, "byId", [
            { eq: [{ col: "id", val: row.id }] },
          ]),
        ),
      ).resolves.toEqual([row]);
      await expect(
        execAsync(
          preloaded.intervalScan(bulkGroupsTable, "byId", [
            { eq: [{ col: "id", val: group.id }] },
          ]),
        ),
      ).resolves.toEqual([group]);
    } finally {
      driver.close();
      await deleteDatabase(databaseName);
    }
  });
});
