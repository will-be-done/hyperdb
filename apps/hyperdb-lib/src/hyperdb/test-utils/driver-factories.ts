import type { DBDriver } from "../core/driver";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { openIndexedDBDriver } from "../drivers/idb/idb-driver";
import { initSqlJsWasm } from "../drivers/sqlite/init-sql-js-wasm";

export type DriverFactory = [string, () => Promise<DBDriver>];

let idbCounter = 0;

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
  return openIndexedDBDriver(dbName);
}

export function createDriverFactories(options?: {
  includeIndexedDB?: boolean;
  includeSql?: boolean;
}): DriverFactory[] {
  const factories: DriverFactory[] = [];
  const isBrowser = hasIndexedDB();

  if (options?.includeSql !== false && !isBrowser) {
    factories.push(["SqlDriver", () => initSqlJsWasm()]);
  }

  factories.push(["BptreeInmemDriver", async () => new BptreeInmemDriver()]);

  if (options?.includeIndexedDB !== false && hasIndexedDB()) {
    factories.push(["IdbDriver", openTestIdbDriver]);
  }

  return factories;
}
