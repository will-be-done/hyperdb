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

  it("builds row tuples per index when selectors share a commit", () => {
    const table = defineTable("memoPeople", {
      id: v.string(),
      group: v.string(),
      name: v.string(),
    })
      .index("byGroup", ["group"])
      .index("byNameGroup", ["name", "group"]);
    const byGroup = selectFrom(table, "byGroup").where((q) =>
      q.eq("group", "g1"),
    );
    const byNameGroup = selectFrom(table, "byNameGroup").where((q) =>
      q.eq("name", "n1").eq("group", "g2"),
    );
    const cmd = (query: typeof byGroup | typeof byNameGroup) =>
      query[Symbol.iterator]().next().value as SelectRangeCmd;
    const ops: Op[] = [
      {
        type: "insert",
        table,
        newValue: { id: "a", group: "g2", name: "n1" },
      },
    ];

    expect(isNeedToRerunRange([cmd(byGroup)], ops)).toBe(false);
    expect(isNeedToRerunRange([cmd(byNameGroup)], ops)).toBe(true);
    expect(isNeedToRerunRange([cmd(byGroup)], ops)).toBe(false);
  });

  it("checks both sides of an upsert and the old row of a delete", () => {
    const table = defineRows();
    const cmds = [rangeCmd(table)];
    const upsert = (oldGroup: string | undefined, newGroup: string): Op[] => [
      {
        type: "upsert",
        table,
        oldValue:
          oldGroup === undefined ? undefined : { id: "a", group: oldGroup },
        newValue: { id: "a", group: newGroup },
      },
    ];

    expect(isNeedToRerunRange(cmds, upsert("g1", "g2"))).toBe(true);
    expect(isNeedToRerunRange(cmds, upsert("g2", "g1"))).toBe(true);
    expect(isNeedToRerunRange(cmds, upsert("g2", "g3"))).toBe(false);
    expect(isNeedToRerunRange(cmds, upsert(undefined, "g3"))).toBe(false);
    expect(
      isNeedToRerunRange(cmds, [
        { type: "delete", table, oldValue: { id: "a", group: "g1" } },
      ]),
    ).toBe(true);
  });
});
