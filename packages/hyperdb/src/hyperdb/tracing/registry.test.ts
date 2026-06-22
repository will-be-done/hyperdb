import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { DB } from "../runtime/db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { HyperDBTraceStore } from "./store";
import {
  getRegisteredHyperDBs,
  subscribeToRegisteredHyperDBs,
} from "./registry";

type HyperDBRegistryGlobal = typeof globalThis & {
  __hyperdb?: unknown;
};

const resetRegistry = (): void => {
  delete (globalThis as HyperDBRegistryGlobal).__hyperdb;
};

beforeEach(() => {
  resetRegistry();
});

afterEach(() => {
  resetRegistry();
});

describe("HyperDB runtime registry", () => {
  it("registers raw DBs with a stable id and label", () => {
    const db = new DB(new BptreeInmemDriver(), { dbName: "Local todos" });

    expect(getRegisteredHyperDBs()).toEqual([
      {
        id: db.getId(),
        label: "Local todos",
        source: "db",
      },
    ]);
  });

  it("does not add or upgrade an entry for SubscribableDB", () => {
    const rawDB = new DB(new BptreeInmemDriver(), { dbName: "Shared DB" });
    const db = new SubscribableDB(rawDB);

    expect(db.getId()).toBe(rawDB.getId());
    expect(getRegisteredHyperDBs()).toEqual([
      {
        id: rawDB.getId(),
        label: "Shared DB",
        source: "db",
      },
    ]);
  });

  it("does not leave a phantom DB entry from withTraits", () => {
    const db = new DB(new BptreeInmemDriver(), { dbName: "Scoped DB" });
    const traitedDB = db.withTraits({
      type: "test.scope",
      value: "import",
    });

    expect(traitedDB.getId()).toBe(db.getId());
    expect(getRegisteredHyperDBs()).toEqual([
      {
        id: db.getId(),
        label: "Scoped DB",
        source: "db",
      },
    ]);
  });

  it("does not register the internal trace store DB", () => {
    new HyperDBTraceStore();

    expect(getRegisteredHyperDBs()).toEqual([]);
  });

  it("notifies subscribers and stops after cleanup", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeToRegisteredHyperDBs((dbs) => {
      snapshots.push(dbs.map((db) => db.label));
    });

    new DB(new BptreeInmemDriver(), { dbName: "First DB" });
    unsubscribe();
    new DB(new BptreeInmemDriver(), { dbName: "Second DB" });

    expect(snapshots).toEqual([["First DB"]]);
  });
});
