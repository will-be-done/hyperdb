import { describe, expect, it, vi } from "vitest";
import { DB, execSync } from "../db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import {
  createAction,
  dispatchMaybeAsync,
  insert,
  syncDispatch,
} from "../commands/action/builders";
import { createSelector, selectSync } from "../commands/selector/selector";
import { HybridDBCrashedError } from "../runtime/hybrid-persistence";
import { defineTable } from "../schema/table";
import { assertValid, v } from "../schema/values";
import { UndoConflictError } from "../undo/manager";
import {
  DuplicateIdError,
  HyperDBError,
  isHyperDBError,
  ValidationError,
} from "./errors";

const rowsTable = defineTable("errorRows", {
  id: v.string(),
  title: v.string(),
});

const action = createAction();
const selector = createSelector();

const insertRows = action({
  name: "insertRows",
  args: { ids: v.array(v.string()) },
  handler: function* ({ ids }) {
    yield* insert(
      rowsTable,
      ids.map((id) => ({ id, title: id })),
    );
    return ids.length;
  },
});

const writingSelector = selector({
  name: "writingSelector",
  args: {},
  // @ts-expect-error selectors cannot write; the runtime guard is tested too
  handler: function* () {
    yield* insert(rowsTable, [{ id: "x", title: "x" }]);
  },
});

const createDB = () => {
  const db = new DB(new BptreeInmemDriver(), { register: false });
  execSync(db.loadTables([rowsTable]));
  return db;
};

describe("HyperDB errors", () => {
  it("throws DuplicateIdError with a stable code and the original message", () => {
    const db = createDB();
    syncDispatch(db, insertRows({ ids: ["a"] }));

    let caught: unknown;
    try {
      syncDispatch(db, insertRows({ ids: ["a"] }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DuplicateIdError);
    expect(caught).toBeInstanceOf(HyperDBError);
    expect(isHyperDBError(caught, "DUPLICATE_ID")).toBe(true);
    expect((caught as DuplicateIdError).id).toBe("a");
    expect((caught as Error).message).toBe(
      "Record with duplicate id already exists: a",
    );
  });

  it("codes writes from selectors as WRITES_DISALLOWED", () => {
    const db = createDB();

    expect(() =>
      selectSync(db, { selector: writingSelector, args: {} }),
    ).toThrow(
      expect.objectContaining({
        code: "WRITES_DISALLOWED",
        message: "Writes are disallowed for command: insert",
      }),
    );
  });

  it("codes validation failures as VALIDATION", () => {
    let caught: unknown;
    try {
      assertValid(v.string(), 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(isHyperDBError(caught, "VALIDATION")).toBe(true);
  });

  it("brings the existing error classes into the hierarchy", () => {
    const crashed = new HybridDBCrashedError(new Error("disk"));
    const conflict = new UndoConflictError("tasks", "t1");

    expect(isHyperDBError(crashed, "HYBRID_DB_CRASHED")).toBe(true);
    expect(crashed.name).toBe("HybridDBCrashedError");
    expect(isHyperDBError(conflict, "UNDO_CONFLICT")).toBe(true);
    expect(conflict.name).toBe("UndoConflictError");
  });

  it("detects errors by brand rather than instanceof", () => {
    const foreign = Object.assign(new Error("other copy"), {
      code: "DUPLICATE_ID",
      [Symbol.for("hyperdb.error")]: true,
    });

    expect(isHyperDBError(foreign, "DUPLICATE_ID")).toBe(true);
    expect(isHyperDBError(foreign, "VALIDATION")).toBe(false);
    expect(isHyperDBError(new Error("plain"))).toBe(false);
    for (const brand of [false, undefined, "true"]) {
      const notBranded = Object.assign(new Error("not branded"), {
        code: "DUPLICATE_ID",
        [Symbol.for("hyperdb.error")]: brand,
      });
      expect(isHyperDBError(notBranded)).toBe(false);
    }
    expect(isHyperDBError(null)).toBe(false);
  });

  it("does not log errors it rethrows", () => {
    const db = createDB();
    syncDispatch(db, insertRows({ ids: ["a"] }));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      expect(() => syncDispatch(db, insertRows({ ids: ["a"] }))).toThrow(
        DuplicateIdError,
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("dispatchMaybeAsync", () => {
  it("returns synchronously when no step needs to wait", () => {
    const db = createDB();

    const result = dispatchMaybeAsync(db, insertRows({ ids: ["a", "b"] }));

    expect(result).toBe(2);
  });
});
