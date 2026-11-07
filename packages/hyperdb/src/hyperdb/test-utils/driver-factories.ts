import { afterEach } from "vitest";
import type { DBDriver } from "../core/driver";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { IdbDriver, openIndexedDBDriver } from "../drivers/idb/idb-driver";
import { deleteTestIndexedDB, uniqueTestDBName } from "./indexeddb";
import { createSqlJsDriver } from "./sql-js-driver";
import { createTursoWasmDriver } from "./turso-wasm-driver";

export type DriverFactory = [string, () => Promise<DBDriver>];

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

async function openTestIdbDriver(): Promise<DBDriver> {
  const dbName = uniqueTestDBName("hyperdb-test");
  await deleteTestIndexedDB(dbName);
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
    factories.push(["AsyncSqlDriver (Turso WASM)", createTursoWasmDriver]);
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
