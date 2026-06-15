import { describe, expect, test, vi } from "vitest";
import { DB, execSync } from "../db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { selectFrom } from "./query/builder";
import { selector } from "./query/selector";
import {
  pruneChildMemo,
  runCommandGenerator,
  type ChildMemo,
  type ChildMemoEntry,
  type ChildVisited,
} from "./runner";
import type { Op } from "../runtime/ops";

const entry = (result: unknown): ChildMemoEntry => ({
  selectRangeCmds: [],
  result,
  childMemo: new Map(),
});

describe("pruneChildMemo", () => {
  test("drops entries whose selector or args were not visited", () => {
    const selA = {};
    const selB = {};
    const childMemo: ChildMemo = new Map([
      [
        selA,
        new Map([
          ["x", entry(1)],
          ["y", entry(2)],
        ]),
      ],
      [selB, new Map([["z", entry(3)]])],
    ]);
    const visited: ChildVisited = new Map([[selA, new Set(["x"])]]);

    pruneChildMemo(childMemo, visited);

    expect(childMemo.has(selB)).toBe(false);
    expect([...childMemo.get(selA)!.keys()]).toEqual(["x"]);
  });

  test("removes a selector whose args map becomes empty", () => {
    const sel = {};
    const childMemo: ChildMemo = new Map([
      [sel, new Map([["x", entry(1)]])],
    ]);
    const visited: ChildVisited = new Map([[sel, new Set(["other"])]]);

    pruneChildMemo(childMemo, visited);

    expect(childMemo.has(sel)).toBe(false);
  });

  test("keeps every entry that was visited", () => {
    const sel = {};
    const childMemo: ChildMemo = new Map([
      [sel, new Map([["x", entry(1)]])],
    ]);
    const visited: ChildVisited = new Map([[sel, new Set(["x"])]]);

    pruneChildMemo(childMemo, visited);

    expect(childMemo.get(sel)!.get("x")!.result).toBe(1);
  });
});

const itemsTable = defineTable("runnerMemoItems", {
  id: v.string(),
  group: v.string(),
  orderToken: v.string(),
}).index("groupOrder", ["group", "orderToken"]);

const makeDb = () => {
  const db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables([itemsTable]));
  return db;
};

const insertOp = (id: string, group: string, orderToken: string): Op => ({
  type: "insert",
  table: itemsTable,
  newValue: { id, group, orderToken },
});

const buildTree = (handler: (group: string) => void) => {
  const child = selector({
    name: "runnerMemoChild",
    args: { group: v.string() },
    handler: function* runnerMemoChild({ group }) {
      handler(group);
      return yield* selectFrom(itemsTable, "groupOrder").where((q) =>
        q.eq("group", group),
      );
    },
  });
  const parent = selector({
    name: "runnerMemoParent",
    args: {},
    handler: function* runnerMemoParent() {
      const a = yield* child({ group: "a" });
      const b = yield* child({ group: "b" });
      return { a: a.length, b: b.length };
    },
  });
  return parent;
};

const runTree = <T>(
  db: SubscribableDB,
  gen: () => Generator<unknown, T, unknown>,
  options: { childMemo: ChildMemo; ops?: Op[] },
): T => {
  const visited: ChildVisited = new Map();
  return execSync(
    runCommandGenerator(db, gen(), {
      selectRangeCmds: [],
      visited,
      childMemo: options.childMemo,
      ops: options.ops,
    }),
  );
};

describe("runCommandGenerator nested selector memo", () => {
  test("skips runSelector arg serialization when childMemo is absent", () => {
    const db = makeDb();
    let getterReads = 0;
    const args = {};
    Object.defineProperty(args, "token", {
      enumerable: true,
      get() {
        getterReads++;
        return "value";
      },
    });
    const manualSelector = {};
    const makeRoot = () =>
      (function* root() {
        return (yield {
          type: "runSelector",
          selector: manualSelector,
          args,
          makeBody: function* manualChild() {
            return "ok";
          },
          name: "manualChild",
        }) as string;
      })();

    expect(
      execSync(
        runCommandGenerator(db, makeRoot(), {
          selectRangeCmds: [],
        }),
      ),
    ).toBe("ok");
    expect(getterReads).toBe(0);

    expect(
      execSync(
        runCommandGenerator(db, makeRoot(), {
          childMemo: new Map(),
          selectRangeCmds: [],
        }),
      ),
    ).toBe("ok");
    expect(getterReads).toBe(1);
  });

  test("populates childMemo on the first run (no ops)", () => {
    const db = makeDb();
    execSync(db.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]));
    const handler = vi.fn();
    const parent = buildTree(handler);
    const childMemo: ChildMemo = new Map();

    const result = runTree(db, () => parent({}), { childMemo });

    expect(result).toEqual({ a: 1, b: 0 });
    expect(handler.mock.calls.map((call) => call[0]).sort()).toEqual([
      "a",
      "b",
    ]);
    // The memo is nested: root scope holds the parent, whose own childMemo
    // holds both child-arg variants.
    expect(childMemo.size).toBe(1);
    const parentEntry = [...childMemo.values()][0]!.get("object:{}")!;
    const childByArgs = [...parentEntry.childMemo.values()][0]!;
    expect([...childByArgs.keys()].sort()).toEqual([
      'object:{"group":string:"a"}',
      'object:{"group":string:"b"}',
    ]);
  });

  test("reruns only the child whose ranges an op intersects", () => {
    const db = makeDb();
    execSync(db.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]));
    const handler = vi.fn();
    const parent = buildTree(handler);
    const childMemo: ChildMemo = new Map();

    runTree(db, () => parent({}), { childMemo });
    handler.mockClear();

    execSync(db.insert(itemsTable, [{ id: "a2", group: "a", orderToken: "b" }]));
    const result = runTree(db, () => parent({}), {
      childMemo,
      ops: [insertOp("a2", "a", "b")],
    });

    expect(result).toEqual({ a: 2, b: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("a");
  });

  test("skips the whole tree when no op intersects any range", () => {
    const db = makeDb();
    execSync(db.insert(itemsTable, [{ id: "a1", group: "a", orderToken: "a" }]));
    const handler = vi.fn();
    const parent = buildTree(handler);
    const childMemo: ChildMemo = new Map();

    runTree(db, () => parent({}), { childMemo });
    handler.mockClear();

    const result = runTree(db, () => parent({}), {
      childMemo,
      ops: [insertOp("c1", "c", "a")],
    });

    // Result is the memoized value; nothing recomputed.
    expect(result).toEqual({ a: 1, b: 0 });
    expect(handler).not.toHaveBeenCalled();
  });
});
