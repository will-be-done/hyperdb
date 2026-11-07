import { describe, expect, it } from "vitest";
import {
  asyncDispatch,
  createAction,
  insert,
  syncDispatch,
  upsert,
} from "./action/builders";
import { selectFrom } from "./selector/builder";
import {
  createCachedSelectorStoreSync,
  createSelector,
  selectSync,
} from "./selector/selector";
import type { SelectRangeCmd } from "./selector/commands";
import type { SelectorGenerator } from "./command-types";
import { DuplicateIdError } from "../core/errors";
import { execAsync, execSync } from "../core/executor";
import { DB } from "../runtime/db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { SyncDB } from "../runtime/sync-db";
import {
  createInspectableSqlAsyncDriver,
  createInspectableSqlDriver,
  createSqlJsDriverFromDatabase,
} from "../test-utils/sql-js-driver";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { createDriverFactories } from "../test-utils/driver-factories";

const usersTable = defineTable("handlerErrorUsers", {
  id: v.string(),
  email: v.string(),
})
  .index("byIds", ["id"])
  .index("byEmail", ["email"], { type: "uniqhash" });

const unloadedTable = defineTable("handlerErrorUnloaded", {
  id: v.string(),
}).index("byIds", ["id"]);

const action = createAction();
const selector = createSelector();

const readUser = async (db: DB, id: string) =>
  (
    await execAsync(
      db.intervalScan(usersTable, "byId", [{ eq: [{ col: "id", val: id }] }]),
    )
  )[0];

describe.each(createDriverFactories())("handler errors on %s", (name, make) => {
  // A failed IndexedDB request aborts the whole IDB transaction, so a caught
  // write failure still rejects the dispatch there; nothing is committed.
  const abortsWholeTransaction = name === "IdbDriver";

  const createDB = async () => {
    const db = new DB(await make(), { register: false });
    await execAsync(db.loadTables([usersTable]));
    await asyncDispatch(
      db,
      action({
        name: "seed",
        args: {},
        handler: function* () {
          yield* insert(usersTable, [
            { id: "a", email: "a@x" },
            { id: "b", email: "b@x" },
          ]);
        },
      })({}),
    );
    return db;
  };

  it("lets a handler catch a failed insert and fall back", async () => {
    const db = await createDB();
    const insertOrUpdate = action({
      name: "insertOrUpdate",
      args: {},
      handler: function* () {
        try {
          yield* insert(usersTable, [{ id: "a", email: "a2@x" }]);
          return "inserted";
        } catch {
          yield* upsert(usersTable, [{ id: "a", email: "a2@x" }]);
          return "updated";
        }
      },
    });

    if (abortsWholeTransaction) {
      await expect(asyncDispatch(db, insertOrUpdate({}))).rejects.toThrow();
      expect(await readUser(db, "a")).toEqual({ id: "a", email: "a@x" });
      return;
    }

    await expect(asyncDispatch(db, insertOrUpdate({}))).resolves.toBe(
      "updated",
    );
    expect(await readUser(db, "a")).toEqual({ id: "a", email: "a2@x" });
  });

  it("keeps a failed batch insert all-or-nothing when the handler swallows it", async () => {
    const db = await createDB();
    let caught: unknown;
    const swallow = action({
      name: "swallowBatchConflict",
      args: {},
      handler: function* () {
        try {
          // "c" is new; "a" collides, so the whole batch must not apply.
          yield* insert(usersTable, [
            { id: "c", email: "c@x" },
            { id: "a", email: "a2@x" },
          ]);
        } catch (error) {
          caught = error;
        }
      },
    });

    if (abortsWholeTransaction) {
      await expect(asyncDispatch(db, swallow({}))).rejects.toThrow();
    } else {
      await asyncDispatch(db, swallow({}));
    }
    expect(await readUser(db, "c")).toBeUndefined();
    expect(caught).toBeInstanceOf(DuplicateIdError);
    expect((caught as DuplicateIdError).id).toBe("a");
  });

  it("runs the handler's finally block and rolls back an uncaught failure", async () => {
    const db = await createDB();
    let cleanedUp = false;
    const failing = action({
      name: "failingInsert",
      args: {},
      handler: function* () {
        yield* insert(usersTable, [{ id: "c", email: "c@x" }]);
        try {
          yield* insert(usersTable, [{ id: "a", email: "dup@x" }]);
        } finally {
          cleanedUp = true;
        }
      },
    });

    await expect(asyncDispatch(db, failing({}))).rejects.toThrow();
    expect(cleanedUp).toBe(true);
    expect(await readUser(db, "c")).toBeUndefined();
  });

  it("keeps a failed upsert all-or-nothing when the handler swallows it", async () => {
    const db = await createDB();
    // Moving a's email onto b's violates the unique index. SQLite upserts as
    // delete + insert, so a half-applied write would lose row "a".
    const swallow = action({
      name: "swallowUpsertConflict",
      args: {},
      handler: function* () {
        try {
          yield* upsert(usersTable, [{ id: "a", email: "b@x" }]);
        } catch {
          return "conflict";
        }
        return "written";
      },
    });

    if (abortsWholeTransaction) {
      await expect(asyncDispatch(db, swallow({}))).rejects.toThrow();
    } else {
      await expect(asyncDispatch(db, swallow({}))).resolves.toBe("conflict");
    }
    expect(await readUser(db, "a")).toEqual({ id: "a", email: "a@x" });
    expect(await readUser(db, "b")).toEqual({ id: "b", email: "b@x" });
  });
});

describe("selector errors", () => {
  it("lets a parent catch a failing child and keeps the child's ranges", () => {
    const db = new DB(new BptreeInmemDriver(), { register: false });
    execSync(db.loadTables([usersTable]));

    const failingChild = selector({
      name: "failingChild",
      args: {},
      handler: function* () {
        yield* selectFrom(usersTable, "byIds").where((q) => q.gte("id", ""));
        // Not loaded, so the driver rejects this scan.
        return yield* selectFrom(unloadedTable, "byIds").where((q) =>
          q.gte("id", ""),
        );
      },
    });
    const parent = selector({
      name: "parentWithFallback",
      args: {},
      handler: function* () {
        try {
          return yield* failingChild({});
        } catch {
          return "fallback";
        }
      },
    });

    const selectRangeCmds: SelectRangeCmd[] = [];
    expect(
      selectSync(db, { selector: parent, args: {}, selectRangeCmds }),
    ).toBe("fallback");
    expect(selectRangeCmds.map((cmd) => cmd.table.tableName)).toContain(
      usersTable.tableName,
    );
  });
});

describe("failures after a write is applied", () => {
  const derivedTable = defineTable("handlerErrorDerived", {
    id: v.string(),
  }).index("byIds", ["id"]);

  it("refuses to commit when a mutation hook fails, even if the handler catches", () => {
    const db = new SubscribableDB(
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    execSync(db.loadTables([usersTable, derivedTable]));
    const hookError = new Error("hook failed");
    db.afterInsert(function* (_db, table) {
      if (table !== usersTable) return;
      yield* insert(derivedTable, [{ id: "derived" }]);
      throw hookError;
    });
    let notified = 0;
    db.subscribe(() => {
      notified++;
    });
    const swallow = action({
      name: "swallowHookFailure",
      args: {},
      handler: function* () {
        try {
          yield* insert(usersTable, [{ id: "a", email: "a@x" }]);
        } catch {
          return "caught";
        }
        return "written";
      },
    });

    expect(() => syncDispatch(db, swallow({}))).toThrow(hookError);
    expect(notified).toBe(0);
    expect(
      execSync(db.intervalScan(usersTable, "byIds", [{ gte: [] }])),
    ).toEqual([]);
    expect(
      execSync(db.intervalScan(derivedTable, "byIds", [{ gte: [] }])),
    ).toEqual([]);
  });

  it("keeps selectors read-only when an action runs them", () => {
    const db = new DB(new BptreeInmemDriver(), { register: false });
    execSync(db.loadTables([usersTable]));
    const writingSelector = selector({
      name: "writingSelectorInAction",
      args: {},
      // Untyped code can still reach this; the runtime must reject it.
      handler: function* () {
        yield* insert(usersTable, [{ id: "x", email: "x@x" }]);
      } as unknown as () => SelectorGenerator<void>,
    });
    const runsSelector = action({
      name: "runsWritingSelector",
      args: {},
      handler: function* () {
        yield* writingSelector({});
      },
    });

    expect(() => syncDispatch(db, runsSelector({}))).toThrow(
      expect.objectContaining({ code: "WRITES_DISALLOWED" }),
    );
  });

  it("does not reuse a child selector's result after its rerun fails", () => {
    const db = new SubscribableDB(
      new DB(new BptreeInmemDriver(), { register: false }),
    );
    execSync(db.loadTables([usersTable, derivedTable]));
    const seed = action({
      name: "seedMemoUsers",
      args: { email: v.string() },
      handler: function* ({ email }) {
        yield* upsert(usersTable, [{ id: "a", email }]);
      },
    });
    const touchDerived = action({
      name: "touchDerived",
      args: { id: v.string() },
      handler: function* ({ id }) {
        yield* insert(derivedTable, [{ id }]);
      },
    });
    syncDispatch(db, seed({ email: "ok@x" }));

    const child = selector({
      name: "memoChild",
      args: {},
      memoization: { selfChild: true },
      handler: function* () {
        const [user] = yield* selectFrom(usersTable, "byIds").where((q) =>
          q.gte("id", ""),
        );
        if (user?.email === "bad@x") throw new Error("bad row");
        return user?.email;
      },
    });
    const parent = selector({
      name: "memoParent",
      args: {},
      handler: function* () {
        // Reading derived rows makes unrelated writes rerun the parent.
        yield* selectFrom(derivedTable, "byIds").where((q) => q.gte("id", ""));
        try {
          return yield* child({});
        } catch {
          return "fallback";
        }
      },
    });
    const store = createCachedSelectorStoreSync(db, {
      selector: parent,
      args: {},
    });
    const unsubscribe = store.subscribe(() => {});

    expect(store.getSnapshot()).toBe("ok@x");
    syncDispatch(db, seed({ email: "bad@x" }));
    expect(store.getSnapshot()).toBe("fallback");
    // Only the parent's own range changes; the failed child must rerun.
    syncDispatch(db, touchDerived({ id: "d1" }));
    expect(store.getSnapshot()).toBe("fallback");
    unsubscribe();
  });
});

describe("SQLite savepoint cleanup failures", () => {
  const seedAndSwallow = action({
    name: "swallowReleaseFailure",
    args: {},
    handler: function* () {
      try {
        yield* upsert(usersTable, [{ id: "a", email: "a2@x" }]);
      } catch {
        return "caught";
      }
      return "written";
    },
  });
  const failRelease = () => {
    let armed = false;
    return {
      arm: () => {
        armed = true;
      },
      beforeExec: (sql: string) => {
        if (armed && sql.startsWith("RELEASE hyperdb_write")) {
          armed = false;
          throw new Error("release failed");
        }
      },
    };
  };

  it("does not commit a write whose savepoint failed to release (sync)", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    const hook = failRelease();
    const { driver } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforeExec: hook.beforeExec,
    });
    const db = new SyncDB(new DB(driver, { register: false }));
    db.loadTables([usersTable]);
    db.insert(usersTable, [{ id: "a", email: "a@x" }]);
    const raw = new DB(driver, { register: false });

    hook.arm();
    expect(() => syncDispatch(raw, seedAndSwallow({}))).toThrow(
      "release failed",
    );
    expect(
      execSync(
        raw.intervalScan(usersTable, "byId", [
          { eq: [{ col: "id", val: "a" }] },
        ]),
      ),
    ).toEqual([{ id: "a", email: "a@x" }]);
  });

  it("does not commit a write whose savepoint failed to release (async)", async () => {
    const hook = failRelease();
    const { driver } = await createInspectableSqlAsyncDriver(
      {},
      { beforeExec: hook.beforeExec },
    );
    const db = new DB(driver, { register: false });
    await execAsync(db.loadTables([usersTable]));
    await execAsync(db.insert(usersTable, [{ id: "a", email: "a@x" }]));

    hook.arm();
    await expect(asyncDispatch(db, seedAndSwallow({}))).rejects.toThrow(
      "release failed",
    );
    expect(await readUser(db, "a")).toEqual({ id: "a", email: "a@x" });
  });
});
