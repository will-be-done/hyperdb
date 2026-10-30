import { describe, expect, it, vi } from "vitest";
import { DB } from "../runtime/db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { HybridDB } from "../runtime/hybrid-db";
import { PreloadedHybridDB } from "../runtime/preloaded-hybrid-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { execAsync, execSync } from "../core/executor";
import {
  asyncDispatch,
  syncDispatch,
  insert,
  upsert,
  deleteRows,
} from "../commands/action/builders";
import { selectFrom } from "../commands/selector/builder";
import { createSelector, selectSync } from "../commands/selector/selector";
import { unwrap } from "../commands/async";
import { createDriverFactories } from "../test-utils/driver-factories";
import {
  undoMiddleware,
  withoutUndo,
  isUndoReplay,
  UndoConflictError,
} from "./index";

const items = defineTable(
  "undoItems",
  v.object({
    id: v.string(),
    value: v.number(),
  }),
).index("all", ["id"]);
const derived = defineTable(
  "undoDerived",
  v.object({
    id: v.string(),
    count: v.number(),
  }),
).index("all", ["id"]);
const binary = defineTable(
  "undoBinary",
  v.object({
    id: v.string(),
    data: v.any(),
  }),
).index("all", ["id"]);

function setup() {
  const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables([items, derived, binary]));
  const history = undoMiddleware(db, { tables: [items] });
  const rows = () => execSync(db.intervalScan(items, "all", [{}]));
  return { db, history, rows };
}

describe("undo middleware", () => {
  it("preserves unique-key swaps in upsert batches", () => {
    const table = defineTable(
      "undoUnique",
      v.object({
        id: v.string(),
        key: v.string(),
      }),
    ).index("key", ["key"], { type: "uniqhash" });
    const { db } = setup();
    execSync(db.loadTables([table]));
    syncDispatch(
      db,
      insert(table, [
        { id: "a", key: "x" },
        { id: "b", key: "y" },
      ]),
    );
    const history = undoMiddleware(db, { tables: [table] });
    syncDispatch(
      db,
      upsert(table, [
        { id: "a", key: "y" },
        { id: "b", key: "x" },
      ]),
    );
    const read = () =>
      execSync(
        db.intervalScan(table, "byId", [
          { eq: [{ col: "id", val: "a" }] },
          { eq: [{ col: "id", val: "b" }] },
        ]),
      ).sort((a, b) => a.id.localeCompare(b.id));
    execSync(history.undo());
    expect(read()).toEqual([
      { id: "a", key: "x" },
      { id: "b", key: "y" },
    ]);
    execSync(history.redo());
    expect(read()).toEqual([
      { id: "a", key: "y" },
      { id: "b", key: "x" },
    ]);
  });

  it("captures write-time normalized values before action inputs are mutated", () => {
    const { db, history, rows } = setup();
    const row = { id: "a", value: 1, extra: undefined };
    syncDispatch(
      db,
      (function* () {
        yield* upsert(items, [row]);
        row.value = 99;
      })(),
    );
    expect(history.undoQueue[0].changes[0].after).toEqual({
      id: "a",
      value: 1,
    });
    execSync(history.undo());
    execSync(history.redo());
    expect(rows()).toEqual([{ id: "a", value: 1 }]);
  });

  it("protects redo from excluded writes and can clear a nonempty redo queue", () => {
    const { db, history, rows } = setup();
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    execSync(history.undo());
    withoutUndo(db, (scoped) =>
      syncDispatch(scoped, insert(items, [{ id: "a", value: 2 }])),
    );
    expect(() => execSync(history.redo())).toThrow(UndoConflictError);
    expect(history.redoLevels).toBe(1);
    expect(rows()).toEqual([{ id: "a", value: 2 }]);
    history.clearRedo();
    expect(history.redoLevels).toBe(0);
  });

  it("preserves commit errors and history when transaction cleanup also fails", () => {
    const { db, history } = setup();
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    const driver = (db.db as DB).driver;
    const beginTx = driver.beginTx.bind(driver);
    const spy = vi
      .spyOn(driver, "beginTx")
      .mockImplementation(function* (mode) {
        const tx = yield* beginTx(mode);
        const rollback = tx.rollback.bind(tx);
        tx.commit = function* () {
          yield* rollback();
          throw new Error("commit failed");
        };
        return tx;
      });
    expect(() => execSync(history.undo())).toThrow("commit failed");
    expect(history.undoLevels).toBe(1);
    expect(history.redoLevels).toBe(0);
    spy.mockRestore();
    execSync(history.undo());
    expect(history.redoLevels).toBe(1);
  });

  it("records committed transactions and replays insert, upsert, and delete", () => {
    const { db, history, rows } = setup();
    syncDispatch(
      db,
      (function* () {
        yield* insert(items, [{ id: "a", value: 1 }]);
        yield* upsert(items, [
          { id: "a", value: 2 },
          { id: "b", value: 3 },
        ]);
        yield* deleteRows(items, ["a", "missing"]);
      })(),
    );
    expect(history.undoLevels).toBe(1);
    expect(rows()).toEqual([{ id: "b", value: 3 }]);
    execSync(history.undo());
    expect(rows()).toEqual([]);
    expect(history.canUndo).toBe(false);
    expect(history.redoLevels).toBe(1);
    execSync(history.redo());
    expect(rows()).toEqual([{ id: "b", value: 3 }]);
    expect(history.undoLevels).toBe(1);
    expect(history.canRedo).toBe(false);
  });

  it("ignores rolled back, read-only, and net-zero transactions", () => {
    const { db, history, rows } = setup();
    expect(() =>
      syncDispatch(
        db,
        (function* () {
          yield* insert(items, [{ id: "a", value: 1 }]);
          throw new Error("abort");
        })(),
      ),
    ).toThrow("abort");
    syncDispatch(
      db,
      (function* () {
        yield* insert(items, [{ id: "a", value: 1 }]);
        yield* deleteRows(items, ["a"]);
      })(),
    );
    syncDispatch(
      db,
      (function* () {
        yield* selectFrom(items, "all");
      })(),
    );
    expect(history.undoLevels).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("captures only selected tables and recreates derived rows through hooks", () => {
    const { db, history } = setup();
    db.afterChange(function* (_tx, table, _traits, ops) {
      if (table.tableName !== items.tableName) return;
      const current = yield* selectFrom(derived, "byId")
        .where((q) => q.eq("id", "count"))
        .first();
      let count = current?.count ?? 0;
      for (const op of ops) {
        if (op.type === "insert" || (op.type === "upsert" && !op.oldValue))
          count++;
        if (op.type === "delete") count--;
      }
      yield* upsert(derived, [{ id: "count", count }]);
    });
    const count = () =>
      execSync(db.intervalScan(derived, "all", [{}]))[0].count;
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    expect(history.undoQueue[0].changes).toHaveLength(1);
    expect(count()).toBe(1);
    execSync(history.undo());
    expect(count()).toBe(0);
    execSync(history.redo());
    expect(count()).toBe(1);
  });

  it("excludes individual mutations for one manager or every manager", () => {
    const { db, history, rows } = setup();
    const other = undoMiddleware(db, { tables: [items] });
    const notifications: number[] = [];
    db.subscribe((ops) => notifications.push(ops.length));
    const result = syncDispatch(
      db,
      (function* () {
        yield* insert(items, [{ id: "recorded", value: 1 }]);
        const value = yield* history.withoutUndo(function* () {
          yield* insert(items, [{ id: "one", value: 2 }]);
          return 42;
        });
        yield* withoutUndo(function* () {
          yield* insert(items, [{ id: "all", value: 3 }]);
        });
        yield* insert(items, [{ id: "after", value: 4 }]);
        return value;
      })(),
    );
    expect(result).toBe(42);
    expect(history.undoQueue[0].changes.map((c) => c.id)).toEqual([
      "recorded",
      "after",
    ]);
    expect(other.undoQueue[0].changes.map((c) => c.id)).toEqual([
      "recorded",
      "one",
      "after",
    ]);
    expect(notifications).toEqual([4]);
    execSync(history.undo());
    expect(
      rows()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["all", "one"]);
    expect(other.undoLevels).toBe(1); // Replay is excluded from all managers.
    expect(() => execSync(other.undo())).toThrow(UndoConflictError);
  });

  it("combines nested manager exclusions and inherits them in mutation hooks", () => {
    const { db, history } = setup();
    const other = undoMiddleware(db, { tables: [items, derived] });
    db.afterChange(function* (_tx, table) {
      if (table.tableName === items.tableName)
        yield* upsert(derived, [{ id: "count", count: 1 }]);
    });
    syncDispatch(
      db,
      history.withoutUndo(function* () {
        yield* other.withoutUndo(function* () {
          yield* insert(items, [{ id: "a", value: 1 }]);
        });
      }),
    );
    expect(history.undoLevels).toBe(0);
    expect(other.undoLevels).toBe(0);
    syncDispatch(db, insert(items, [{ id: "b", value: 2 }]));
    expect(history.undoLevels).toBe(1);
    expect(other.undoLevels).toBe(1);
  });

  it("supports scoped callback helpers, including Promise results", async () => {
    const { db, history } = setup();
    const other = undoMiddleware(db, { tables: [items] });
    const value = history.withoutUndo((scoped) => {
      syncDispatch(scoped, insert(items, [{ id: "a", value: 1 }]));
      return "value";
    });
    expect(value).toBe("value");
    expect(history.undoLevels).toBe(0);
    expect(other.undoLevels).toBe(1);
    await withoutUndo(db, async (scoped) => {
      await Promise.resolve();
      await asyncDispatch(scoped, insert(items, [{ id: "b", value: 2 }]));
    });
    expect(other.undoLevels).toBe(1);
    syncDispatch(db, insert(items, [{ id: "c", value: 3 }]));
    expect(history.undoLevels).toBe(1);
  });

  it("does not permit writes from a selector inside an exclusion", () => {
    const { db } = setup();
    const selector = createSelector()({
      name: "invalidUndoSelector",
      args: {},
      handler: function* () {
        yield* withoutUndo(function* () {
          yield* insert(items, [{ id: "a", value: 1 }]);
        });
      },
    });
    expect(() => selectSync(db, { selector, args: {} })).toThrow(
      "Writes are disallowed",
    );
  });

  it("groups transactions and nested groups into one named step", () => {
    const { history, rows } = setup();
    const result = history.withGroup("two edits", (scoped) => {
      syncDispatch(scoped, insert(items, [{ id: "a", value: 1 }]));
      history.withGroup((nested) => {
        syncDispatch(nested, upsert(items, [{ id: "a", value: 2 }]));
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(history.undoLevels).toBe(1);
    expect(history.undoQueue[0].name).toBe("two edits");
    execSync(history.undo());
    expect(rows()).toEqual([]);
    execSync(history.redo());
    expect(rows()).toEqual([{ id: "a", value: 2 }]);
  });

  it("supports manual groups across separate synchronous blocks", async () => {
    const { db, history, rows } = setup();
    const group = history.createGroup("gesture");
    group.continue((scoped) =>
      syncDispatch(scoped, insert(items, [{ id: "a", value: 1 }])),
    );
    await Promise.resolve();
    expect(() => execSync(history.undo())).toThrow("End the open undo group");
    group.continue((scoped) =>
      syncDispatch(scoped, upsert(items, [{ id: "a", value: 2 }])),
    );
    group.end();
    group.end();
    expect(history.undoLevels).toBe(1);
    execSync(history.undo());
    expect(rows()).toEqual([]);
    expect(() => group.continue(() => {})).toThrow("closed");
    expect(() =>
      syncDispatch(db, insert(items, [{ id: "a", value: 3 }])),
    ).not.toThrow();
  });

  it("closes a manual group before an unrelated recorded edit", () => {
    const { db, history, rows } = setup();
    const group = history.createGroup("gesture");
    group.continue((scoped) =>
      syncDispatch(scoped, insert(items, [{ id: "a", value: 1 }])),
    );
    syncDispatch(db, upsert(items, [{ id: "a", value: 2 }]));
    expect(history.undoLevels).toBe(2);
    expect(() => group.continue(() => {})).toThrow("closed");
    execSync(history.undo());
    expect(rows()).toEqual([{ id: "a", value: 1 }]);
    execSync(history.undo());
    expect(rows()).toEqual([]);
  });

  it("retains committed group edits if a later block throws", () => {
    const { db, history, rows } = setup();
    expect(() =>
      history.withGroup((scoped) => {
        syncDispatch(scoped, insert(items, [{ id: "a", value: 1 }]));
        throw new Error("later failure");
      }),
    ).toThrow("later failure");
    expect(history.undoLevels).toBe(1);
    expect(rows()).toHaveLength(1);
    execSync(history.undo());
    expect(rows()).toEqual([]);
    expect(() => history.withGroup(() => Promise.resolve())).toThrow(
      "must be synchronous",
    );
    syncDispatch(db, insert(items, [{ id: "b", value: 2 }]));
    expect(history.undoLevels).toBe(1);
  });

  it("rejects conflicts atomically and preserves both queues", () => {
    const { db, history, rows } = setup();
    syncDispatch(
      db,
      insert(items, [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ]),
    );
    withoutUndo(db, (scoped) =>
      syncDispatch(scoped, upsert(items, [{ id: "a", value: 99 }])),
    );
    const before = rows();
    expect(() => execSync(history.undo())).toThrow(UndoConflictError);
    expect(rows()).toEqual(before);
    expect(history.undoLevels).toBe(1);
    expect(history.redoLevels).toBe(0);
  });

  it("rejects excluded writes between recorded writes to the same row", () => {
    const { db, history, rows } = setup();
    syncDispatch(
      db,
      (function* () {
        yield* insert(items, [{ id: "a", value: 1 }]);
        yield* withoutUndo(function* () {
          yield* upsert(items, [{ id: "a", value: 2 }]);
        });
        yield* upsert(items, [{ id: "a", value: 3 }]);
      })(),
    );
    expect(() => execSync(history.undo())).toThrow(UndoConflictError);
    expect(rows()).toEqual([{ id: "a", value: 3 }]);
  });

  it("rolls back hook failures and allows retrying the same history entry", () => {
    const { db, history, rows } = setup();
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    const off = db.afterChange(function* (_tx, _table, traits) {
      if (_table.tableName === items.tableName && isUndoReplay(traits)) {
        yield* insert(derived, [{ id: "rollback", count: 1 }]);
        throw new Error("hook failed");
      }
    });
    expect(() => execSync(history.undo())).toThrow("hook failed");
    expect(rows()).toEqual([{ id: "a", value: 1 }]);
    expect(execSync(db.intervalScan(derived, "all", [{}]))).toEqual([]);
    expect(history.undoLevels).toBe(1);
    off();
    execSync(history.undo());
    expect(rows()).toEqual([]);
    expect(history.redoLevels).toBe(1);
  });

  it("rejects hook changes to replayed domain rows", () => {
    const { db, history, rows } = setup();
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    db.afterDelete(function* () {
      yield* upsert(items, [{ id: "a", value: 99 }]);
    });
    expect(() => execSync(history.undo())).toThrow(UndoConflictError);
    expect(rows()).toEqual([{ id: "a", value: 1 }]);
  });

  it("bounds history, clears queues, and clears redo on a new recorded edit", () => {
    const { db } = setup();
    const history = undoMiddleware(db, {
      tables: [items],
      maxUndoLevels: 2,
      maxRedoLevels: 1,
    });
    for (let value = 1; value <= 3; value++)
      syncDispatch(db, upsert(items, [{ id: "a", value }]));
    expect(history.undoLevels).toBe(2);
    execSync(history.undo());
    execSync(history.undo());
    expect(history.redoLevels).toBe(1);
    execSync(history.redo());
    expect(history.redoLevels).toBe(0);
    execSync(history.undo());
    syncDispatch(db, insert(items, [{ id: "b", value: 1 }]));
    expect(history.redoLevels).toBe(0);
    history.clearUndo();
    history.clearRedo();
    expect(history.store.undoQueue).toEqual([]);
    expect(() => execSync(history.undo())).toThrow("Nothing to undo");
    expect(() => execSync(history.redo())).toThrow("Nothing to redo");
    const zero = undoMiddleware(db, { tables: [items], maxUndoLevels: 0 });
    syncDispatch(db, insert(items, [{ id: "c", value: 1 }]));
    expect(zero.canUndo).toBe(false);
    expect(() =>
      undoMiddleware(db, { tables: [items], maxRedoLevels: -1 }),
    ).toThrow("limits");
  });

  it("owns row snapshots and exposes defensive queue copies, including binary", () => {
    const { db } = setup();
    const history = undoMiddleware(db, { tables: [binary] });
    const data = {
      nested: [1n],
      bytes: new Uint8Array([1, 2]),
      buffer: new Uint8Array([3]).buffer,
    };
    syncDispatch(db, insert(binary, [{ id: "a", data }]));
    const exposed = history.undoQueue[0].changes[0].after!.data as typeof data;
    exposed.bytes[0] = 99;
    new Uint8Array(exposed.buffer)[0] = 99;
    execSync(history.undo());
    data.nested[0] = 2n;
    data.bytes[0] = 88;
    execSync(history.redo());
    const restored = execSync(db.intervalScan(binary, "all", [{}]))[0]
      .data as typeof data;
    expect(restored.nested).toEqual([1n]);
    expect([...restored.bytes]).toEqual([1, 2]);
    expect([...new Uint8Array(restored.buffer)]).toEqual([3]);
  });

  it("notifies history subscribers and detaches on disposal", () => {
    const { db, history } = setup();
    const listener = vi.fn();
    const off = history.subscribe(listener);
    const revision = history.getRevision();
    syncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(history.getRevision()).toBeGreaterThan(revision);
    execSync(history.undo());
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    history.dispose();
    history.dispose();
    syncDispatch(db, insert(items, [{ id: "b", value: 2 }]));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(history.undoLevels).toBe(0);
    expect(() => execSync(history.redo())).toThrow("disposed");
  });
});

describe("undo across runtimes", () => {
  for (const [name, createDriver] of createDriverFactories()) {
    it(`replays transactions with ${name}`, async () => {
      const db = new SubscribableDB(new DB(await createDriver()));
      await execAsync(db.loadTables([items]));
      const history = undoMiddleware(db, { tables: [items] });
      await asyncDispatch(
        db,
        (function* () {
          yield* insert(items, [{ id: "a", value: 1 }]);
          yield* upsert(items, [
            { id: "a", value: 2 },
            { id: "b", value: 3 },
          ]);
          yield* deleteRows(items, ["a"]);
        })(),
      );
      await execAsync(history.undo());
      expect(await execAsync(db.intervalScan(items, "all", [{}]))).toEqual([]);
      await execAsync(history.redo());
      expect(await execAsync(db.intervalScan(items, "all", [{}]))).toEqual([
        { id: "b", value: 3 },
      ]);
    });
  }

  for (const Runtime of [HybridDB, PreloadedHybridDB]) {
    it(`replays with ${Runtime.name}`, async () => {
      const db = new SubscribableDB(
        Runtime === HybridDB
          ? new HybridDB(
              new DB(new BptreeInmemDriver()),
              new DB(new BptreeInmemDriver()),
            )
          : new PreloadedHybridDB(new DB(new BptreeInmemDriver())),
      );
      await execAsync(db.loadTables([items]));
      const history = undoMiddleware(db, { tables: [items] });
      await asyncDispatch(db, insert(items, [{ id: "a", value: 1 }]));
      await execAsync(history.undo());
      expect(await execAsync(db.intervalScan(items, "all", [{}]))).toEqual([]);
      await execAsync(history.redo());
      expect(await execAsync(db.intervalScan(items, "all", [{}]))).toEqual([
        { id: "a", value: 1 },
      ]);
    });
  }

  it("isolates exclusions across async work and transaction failures", async () => {
    const { db, history } = setup();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const excluded = withoutUndo(db, async (scoped) => {
      await wait;
      await asyncDispatch(
        scoped,
        insert(items, [{ id: "excluded", value: 1 }]),
      );
    });
    // An async callback must not suppress unrelated writes while it is waiting.
    syncDispatch(db, insert(items, [{ id: "recorded", value: 2 }]));
    release();
    await excluded;
    expect(history.undoLevels).toBe(1);
    expect(history.undoQueue[0].changes[0].id).toBe("recorded");
    await expect(
      asyncDispatch(
        db,
        withoutUndo(function* () {
          yield* unwrap(Promise.reject(new Error("async failure")));
        }),
      ),
    ).rejects.toThrow("async failure");
    await asyncDispatch(db, insert(items, [{ id: "after", value: 3 }]));
    expect(history.undoLevels).toBe(2);
  });
});
