import { describe, expect, it, vi } from "vitest";
import {
  asyncDispatch,
  createAction,
  insert,
} from "../commands/action/builders";
import { unwrap } from "../commands/async";
import { execAsync, execSync } from "../core/executor";
import { isHyperDBError } from "../core/errors";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { getRegisteredHyperDBs } from "../tracing/registry";
import { selectFrom } from "../commands/selector/builder";
import {
  createSelector,
  selectCachedSync,
} from "../commands/selector/selector";
import { DB } from "./db";
import { HybridDB } from "./hybrid-db";
import { PreloadedHybridDB } from "./preloaded-hybrid-db";
import { SubscribableDB } from "./subscribable-db";

const rowsTable = defineTable("closeRows", {
  id: v.string(),
}).index("byIds", ["id"]);

const action = createAction();
const insertRow = action({
  name: "insertRow",
  args: { id: v.string() },
  handler: function* ({ id }) {
    yield* insert(rowsTable, [{ id }]);
  },
});

const expectClosed = (run: () => unknown) => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isHyperDBError(caught, "DB_CLOSED")).toBe(true);
};

describe("close()", () => {
  it("closes the driver, unregisters the DB, and rejects later operations", () => {
    const driver = new BptreeInmemDriver();
    const db = new DB(driver, { dbName: "closing" });
    execSync(db.loadTables([rowsTable]));
    expect(getRegisteredHyperDBs().some((info) => info.id === db.getId())).toBe(
      true,
    );

    execSync(db.close());

    expect(db.isClosed).toBe(true);
    expect(getRegisteredHyperDBs().some((info) => info.id === db.getId())).toBe(
      false,
    );
    expectClosed(() => execSync(db.beginTx()));
    expectClosed(() =>
      execSync(db.intervalScan(rowsTable, "byIds", [{ gte: [] }])),
    );
    expectClosed(() => execSync(db.withTraits({ type: "t" }).beginTx()));
    // Closing twice is a no-op.
    execSync(db.close());
  });

  it("flushes HybridDB persistence before closing primary and cache", async () => {
    const primaryDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const cache = new DB(new BptreeInmemDriver(), { register: false });
    const hybrid = new HybridDB(primary, cache);
    const db = new SubscribableDB(hybrid);
    await execAsync(db.loadTables([rowsTable]));
    let notified = 0;
    db.subscribe(() => {
      notified++;
    });

    // Spy on the driver: persistence reaches the primary through withTraits()
    // copies, which share the driver but not instance-level spies.
    const events: string[] = [];
    const begin = primaryDriver.beginTx.bind(primaryDriver);
    // DB passes the mode even though the in-memory driver ignores it.
    vi.spyOn(primaryDriver, "beginTx").mockImplementation(function* (
      ...args: unknown[]
    ) {
      const tx = yield* begin();
      if (args[0] !== "readwrite") return tx;
      const commit = tx.commit.bind(tx);
      tx.commit = function* () {
        // Keep the flush pending so close() has to wait for it.
        yield* unwrap(new Promise((resolve) => setTimeout(resolve, 10)));
        yield* commit();
        events.push("persisted");
      };
      return tx;
    });
    const closeDriver = primaryDriver.close.bind(primaryDriver);
    vi.spyOn(primaryDriver, "close").mockImplementation(() => {
      events.push("primary closed");
      closeDriver();
    });

    await asyncDispatch(db, insertRow({ id: "r1" }));
    expect(events).toEqual([]);
    await execAsync(db.close());

    expect(events).toEqual(["persisted", "primary closed"]);
    expect(notified).toBe(1);
    expect(db.subscribers).toHaveLength(0);
    expect(primary.isClosed).toBe(true);
    expect(cache.isClosed).toBe(true);
    expectClosed(() => execSync(hybrid.beginTx()));
    await expect(execAsync(hybrid.waitForPersistence())).rejects.toSatisfy(
      (error) => isHyperDBError(error, "DB_CLOSED"),
    );
  });

  it("closes a crashed HybridDB without rethrowing the crash", async () => {
    const primaryDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const cache = new DB(new BptreeInmemDriver(), { register: false });
    const hybrid = new HybridDB(primary, cache);
    await execAsync(hybrid.loadTables([rowsTable]));
    const begin = primaryDriver.beginTx.bind(primaryDriver);
    vi.spyOn(primaryDriver, "beginTx").mockImplementation(function* (
      ...args: unknown[]
    ) {
      if (args[0] === "readwrite") throw new Error("disk gone");
      return yield* begin();
    });

    await asyncDispatch(hybrid, insertRow({ id: "r1" }));
    await execAsync(hybrid.close());

    expect(hybrid.isCrashed).toBe(true);
    expect(primary.isClosed).toBe(true);
    expectClosed(() => execSync(hybrid.beginTx()));
  });

  it("closes PreloadedHybridDB and its primary", async () => {
    const primary = new DB(new BptreeInmemDriver(), { register: false });
    const db = new PreloadedHybridDB(primary);
    await execAsync(db.loadTables([rowsTable]));
    await asyncDispatch(db, insertRow({ id: "r1" }));

    await execAsync(db.close());

    expect(primary.isClosed).toBe(true);
    expectClosed(() => execSync(db.beginTx()));
  });

  it("waits for a commit accepted before close() and refuses later ones", async () => {
    const primaryDriver = new BptreeInmemDriver();
    const cacheDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const cache = new DB(cacheDriver, { register: false });
    const hybrid = new HybridDB(primary, cache);
    await execAsync(hybrid.loadTables([rowsTable]));

    // Hold the cache commit so close() starts while the commit is in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beginCache = cacheDriver.beginTx.bind(cacheDriver);
    vi.spyOn(cacheDriver, "beginTx").mockImplementationOnce(function* () {
      const tx = yield* beginCache();
      const commit = tx.commit.bind(tx);
      tx.commit = function* () {
        yield* unwrap(gate);
        yield* commit();
      };
      return tx;
    });
    const events: string[] = [];
    const beginPrimary = primaryDriver.beginTx.bind(primaryDriver);
    vi.spyOn(primaryDriver, "beginTx").mockImplementation(function* (
      ...args: unknown[]
    ) {
      const tx = yield* beginPrimary();
      if (args[0] !== "readwrite") return tx;
      const commit = tx.commit.bind(tx);
      tx.commit = function* () {
        yield* commit();
        events.push("persisted");
      };
      return tx;
    });
    const closePrimary = primaryDriver.close.bind(primaryDriver);
    vi.spyOn(primaryDriver, "close").mockImplementation(() => {
      events.push("primary closed");
      closePrimary();
    });

    const accepted = asyncDispatch(hybrid, insertRow({ id: "r1" }));
    await Promise.resolve();
    const closing = execAsync(hybrid.close());
    const late = asyncDispatch(hybrid, insertRow({ id: "r2" }));
    release();

    await expect(accepted).resolves.toBeUndefined();
    await expect(late).rejects.toSatisfy((error) =>
      isHyperDBError(error, "DB_CLOSED"),
    );
    await closing;
    expect(events).toEqual(["persisted", "primary closed"]);
  });

  it("lets close() be retried after a driver fails to close", async () => {
    const driver = new BptreeInmemDriver();
    const db = new DB(driver, { register: false });
    execSync(db.loadTables([rowsTable]));
    vi.spyOn(driver, "close").mockImplementationOnce(() => {
      throw new Error("busy");
    });

    expect(() => execSync(db.close())).toThrow("busy");
    expect(db.isClosed).toBe(false);
    execSync(db.close());
    expect(db.isClosed).toBe(true);

    const primaryDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const hybrid = new HybridDB(
      primary,
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    await execAsync(hybrid.loadTables([rowsTable]));
    vi.spyOn(primaryDriver, "close").mockImplementationOnce(() => {
      throw new Error("busy");
    });
    await expect(execAsync(hybrid.close())).rejects.toThrow("busy");
    await execAsync(hybrid.close());
    expect(primary.isClosed).toBe(true);
  });

  it("runs concurrent HybridDB close() calls as one close", async () => {
    const primaryDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const hybrid = new HybridDB(
      primary,
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    await execAsync(hybrid.loadTables([rowsTable]));
    const closePrimary = vi.spyOn(primary, "close");

    // The write keeps the first close() in settle() while the second starts.
    const write = asyncDispatch(hybrid, insertRow({ id: "r1" }));
    await Promise.resolve();
    await Promise.all([
      execAsync(hybrid.close()),
      execAsync(hybrid.close()),
      write,
    ]);

    expect(closePrimary).toHaveBeenCalledTimes(1);
    expect(hybrid.isClosed).toBe(true);
  });

  it("lets a waiting close() finish when the first close is abandoned", async () => {
    const primary = new DB(new BptreeInmemDriver(), { register: false });
    const hybrid = new HybridDB(
      primary,
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    await execAsync(hybrid.loadTables([rowsTable]));
    const closePrimary = vi.spyOn(primary, "close");

    const write = asyncDispatch(hybrid, insertRow({ id: "r1" }));
    await Promise.resolve();
    // Park the first close in settle(), then abandon it.
    const abandoned = hybrid.close();
    abandoned.next();
    const waiting = execAsync(hybrid.close());
    abandoned.return(undefined);

    await Promise.all([waiting, write]);

    expect(closePrimary).toHaveBeenCalledTimes(1);
    expect(hybrid.isClosed).toBe(true);
  });

  it("shares a failed concurrent close with every caller, then allows a retry", async () => {
    const primaryDriver = new BptreeInmemDriver();
    const primary = new DB(primaryDriver, { register: false });
    const db = new PreloadedHybridDB(primary);
    await execAsync(db.loadTables([rowsTable]));
    vi.spyOn(primaryDriver, "close").mockImplementationOnce(() => {
      throw new Error("busy");
    });

    const write = asyncDispatch(db, insertRow({ id: "r1" }));
    await Promise.resolve();
    const results = await Promise.allSettled([
      execAsync(db.close()),
      execAsync(db.close()),
      write,
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
    ]);
    await execAsync(db.close());
    expect(primary.isClosed).toBe(true);
  });

  it("rejects SubscribableDB operations after close when the wrapped DB has no close()", () => {
    const inner = new DB(new BptreeInmemDriver(), { register: false });
    Object.defineProperty(inner, "close", { value: undefined });
    const db = new SubscribableDB(inner);
    execSync(db.loadTables([rowsTable]));

    execSync(db.close());

    expect(db.isClosed).toBe(true);
    expectClosed(() => execSync(db.beginTx()));
    expectClosed(() =>
      execSync(db.intervalScan(rowsTable, "byIds", [{ gte: [] }])),
    );
    expectClosed(() => execSync(db.withTraits({ type: "t" }).beginTx()));
    // Creating the command does not throw; running it does.
    const load = db.loadTables([rowsTable]);
    const preload = db.preloadTables([]);
    expectClosed(() => execSync(load));
    expectClosed(() => execSync(preload));
  });

  it("clears SubscribableDB listeners even when the inner close fails", () => {
    const driver = new BptreeInmemDriver();
    const db = new SubscribableDB(new DB(driver, { register: false }));
    execSync(db.loadTables([rowsTable]));
    db.subscribe(() => {});
    vi.spyOn(driver, "close").mockImplementationOnce(() => {
      throw new Error("busy");
    });

    expect(() => execSync(db.close())).toThrow("busy");
    expect(db.subscribers).toHaveLength(0);
  });

  it("rejects cached selector reads after close", () => {
    const db = new SubscribableDB(
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    execSync(db.loadTables([rowsTable]));
    const allRows = createSelector()({
      name: "closeAllRows",
      args: {},
      handler: function* () {
        return yield* selectFrom(rowsTable, "byIds").where((q) =>
          q.gte("id", ""),
        );
      },
    });
    expect(selectCachedSync(db, { selector: allRows, args: {} })).toEqual([]);

    execSync(db.close());

    expectClosed(() => selectCachedSync(db, { selector: allRows, args: {} }));
  });

  it("releases PreloadedHybridDB's preloaded data on close", async () => {
    const primary = new DB(new BptreeInmemDriver(), { register: false });
    const db = new PreloadedHybridDB(primary);
    await execAsync(db.loadTables([rowsTable]));
    await asyncDispatch(db, insertRow({ id: "r1" }));
    const state = (db as unknown as { state: { data: object } }).state;
    const before = state.data;

    await execAsync(db.close());

    expect(state.data).not.toBe(before);
    expect(db.isClosed).toBe(true);
  });
});
