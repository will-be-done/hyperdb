import { describe, expect, it } from "vitest";
import { createAction, insert, syncDispatch } from "../action/builders";
import { unwrap } from "../async";
import { execAsync, execSync } from "../../core/executor";
import { BptreeInmemDriver } from "../../drivers/inmemory/bptree-inmem-driver";
import { DB } from "../../runtime/db";
import { HybridDB } from "../../runtime/hybrid-db";
import { SubscribableDB } from "../../runtime/subscribable-db";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { selectFrom } from "./builder";
import {
  createCachedSelectorStoreSync,
  createSelector,
  getSubscribableHybridCacheDB,
  preloadSelectorAsync,
  selectCachedSync,
} from "./selector";

const rowsTable = defineTable("selectorCacheRows", {
  id: v.string(),
}).index("byIds", ["id"]);

const selector = createSelector();
const action = createAction();
const insertRow = action({
  name: "selectorCacheInsert",
  args: { id: v.string() },
  handler: function* ({ id }) {
    yield* insert(rowsTable, [{ id }]);
  },
});

const createMemDB = () => {
  const db = new SubscribableDB(
    new DB(new BptreeInmemDriver(), { register: false }),
  );
  execSync(db.loadTables([rowsTable]));
  return db;
};

describe("selector cache", () => {
  it("keeps a Promise returned by a selector as the sync cached value", () => {
    const db = createMemDB();
    const value = Promise.resolve(42);
    const promiseSelector = selector({
      name: "promiseValueSelector",
      args: {},
      handler: function* () {
        yield* selectFrom(rowsTable, "byIds").where((q) => q.gte("id", ""));
        return value;
      },
    });

    expect(selectCachedSync(db, { selector: promiseSelector, args: {} })).toBe(
      value,
    );
    expect(selectCachedSync(db, { selector: promiseSelector, args: {} })).toBe(
      value,
    );
  });

  it("does not prime the cache with a preload made stale by a write", async () => {
    const db = createMemDB();
    const cacheDB = createMemDB();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    let waitForGate = true;
    const countRows = selector({
      name: "stalePreloadCount",
      args: {},
      handler: function* () {
        runs++;
        const rows = yield* selectFrom(rowsTable, "byIds").where((q) =>
          q.gte("id", ""),
        );
        if (waitForGate) {
          waitForGate = false;
          yield* unwrap(gate);
        }
        return rows.length;
      },
    });

    const preload = preloadSelectorAsync(db, {
      selector: countRows,
      args: {},
      cacheDB,
    });
    syncDispatch(db, insertRow({ id: "r1" }));
    release();
    await preload;

    const store = createCachedSelectorStoreSync(cacheDB, {
      selector: countRows,
      args: {},
    });
    store.getSnapshot();
    // Not primed: the cache DB had to run the selector itself.
    expect(runs).toBe(2);
  });

  it("reuses a subscribable cache from another HyperDB copy", async () => {
    const realCache = new SubscribableDB(
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    // Another bundle copy: same shape, but instanceof fails.
    const foreignCache = new Proxy(realCache, {
      getPrototypeOf: () => Object.prototype,
    });
    expect(foreignCache instanceof SubscribableDB).toBe(false);
    const hybrid = new HybridDB(
      new DB(new BptreeInmemDriver(), { register: false }),
      foreignCache,
    );
    const db = new SubscribableDB(hybrid);
    await execAsync(db.loadTables([rowsTable]));

    expect(getSubscribableHybridCacheDB(db)).toBe(foreignCache);
  });

  it("releases the synthesized cache wrapper's subscriptions on close", async () => {
    const db = new SubscribableDB(
      new HybridDB(
        new DB(new BptreeInmemDriver(), { register: false }),
        new DB(new BptreeInmemDriver(), { register: false }),
      ),
    );
    await execAsync(db.loadTables([rowsTable]));
    const wrapper = getSubscribableHybridCacheDB(db)!;
    wrapper.subscribe(() => {});
    expect(wrapper.subscribers).toHaveLength(1);

    await execAsync(db.close());

    expect(wrapper.subscribers).toHaveLength(0);
  });
});
