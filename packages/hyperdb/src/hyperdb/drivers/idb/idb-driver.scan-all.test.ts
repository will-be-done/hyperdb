import { describe, expect, it } from "vitest";
import { execAsync } from "../../core/executor";
import { DB } from "../../runtime/db";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { openIndexedDBDriver } from "./idb-driver";

const bulkRowsTable = defineTable("idbScanAllBulkRows", {
  id: v.string(),
  value: v.number(),
});

let databaseCounter = 0;

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to delete test database"));
    request.onblocked = () =>
      reject(new Error("IndexedDB delete request was blocked"));
  });
}

describe("IdbDriver scanAll", () => {
  it("reads at least 1,001 decoded rows in key order", async () => {
    databaseCounter += 1;
    const databaseName = `hyperdb-idb-scan-all-${Date.now().toString(36)}-${databaseCounter}`;
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
});
