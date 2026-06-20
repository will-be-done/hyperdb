import { afterEach } from "vitest";
import type { DBDriver } from "../core/driver";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { IdbDriver, openIndexedDBDriver } from "../drivers/idb/idb-driver";
import { createSqlJsDriver } from "./sql-js-driver";

export type DriverFactory = [string, () => Promise<DBDriver>];

let idbCounter = 0;
const openIdbDrivers = new Set<IdbDriver>();

afterEach(() => {
  for (const driver of openIdbDrivers) {
    driver.close();
  }
  openIdbDrivers.clear();
});

function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

function deleteIndexedDBDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to delete IndexedDB database"));
    request.onblocked = () =>
      reject(new Error("IndexedDB delete request was blocked"));
  });
}

async function openTestIdbDriver(): Promise<DBDriver> {
  idbCounter += 1;
  const dbName = `hyperdb-test-${Date.now().toString(36)}-${idbCounter}`;
  await deleteIndexedDBDatabase(dbName);
  const driver = await openIndexedDBDriver(dbName);
  openIdbDrivers.add(driver);
  return driver;
}

export function createDriverFactories(options?: {
  includeIndexedDB?: boolean;
  includeSql?: boolean;
}): DriverFactory[] {
  const factories: DriverFactory[] = [];

  if (options?.includeSql !== false) {
    factories.push(["SqlDriver", () => createSqlJsDriver()]);
  }

  factories.push(["BptreeInmemDriver", async () => new BptreeInmemDriver()]);

  if (options?.includeIndexedDB !== false) {
    if (!hasIndexedDB()) {
      throw new Error("IndexedDB is required for shared HyperDB driver tests");
    }

    factories.push(["IdbDriver", openTestIdbDriver]);
  }

  return factories;
}
