import { describe, expect, it } from "vitest";
import type { Op } from "../../runtime/ops";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { selectFrom } from "./builder";
import type { SelectRangeCmd } from "./commands";
import { isNeedToRerunRange } from "./selector-memo";

const defineRows = () =>
  defineTable("memoRows", { id: v.string(), group: v.string() }).index(
    "byGroup",
    ["group"],
  );
const otherTable = defineTable("memoOther", { id: v.string() });

const rangeCmd = (table: ReturnType<typeof defineRows>): SelectRangeCmd => {
  const query = selectFrom(table, "byGroup").where((q) => q.eq("group", "g1"));
  return query[Symbol.iterator]().next().value as SelectRangeCmd;
};

describe("isNeedToRerunRange", () => {
  it("matches ops on an equivalent definition of the same table", () => {
    const selectorTable = defineRows();
    const actionTable = defineRows();
    const ops: Op[] = [
      {
        type: "insert",
        table: actionTable,
        newValue: { id: "a", group: "g1" },
      },
    ];

    expect(isNeedToRerunRange([rangeCmd(selectorTable)], ops)).toBe(true);
  });

  it("regroups an ops array that changed after it was first checked", () => {
    const table = defineRows();
    const cmds = [rangeCmd(table)];
    const ops: Op[] = [
      { type: "insert", table: otherTable, newValue: { id: "x" } },
    ];

    expect(isNeedToRerunRange(cmds, ops)).toBe(false);
    ops.push({ type: "insert", table, newValue: { id: "a", group: "g1" } });
    expect(isNeedToRerunRange(cmds, ops)).toBe(true);
  });
});
