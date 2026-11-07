import { describe, expect, it } from "vitest";
import { asyncDispatch, createAction, insert, upsert } from "./action/builders";
import { selectFrom } from "./selector/builder";
import { createSelector, selectSync } from "./selector/selector";
import type { SelectRangeCmd } from "./selector/commands";
import { execAsync, execSync } from "../core/executor";
import { DB } from "../runtime/db";
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
