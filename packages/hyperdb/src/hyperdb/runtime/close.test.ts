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
    vi.spyOn(primaryDriver, "beginTx").mockImplementation(
      function* (mode, options) {
        const tx = yield* begin(mode, options);
        if (mode !== "readwrite") return tx;
        const commit = tx.commit.bind(tx);
        tx.commit = function* () {
          // Keep the flush pending so close() has to wait for it.
          yield* unwrap(new Promise((resolve) => setTimeout(resolve, 10)));
          yield* commit();
          events.push("persisted");
        };
        return tx;
      },
    );
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
    vi.spyOn(primaryDriver, "beginTx").mockImplementation(
      function* (mode, options) {
        if (mode === "readwrite") throw new Error("disk gone");
        return yield* begin(mode, options);
      },
    );

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
});
