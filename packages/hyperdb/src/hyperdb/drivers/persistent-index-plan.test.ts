import { describe, expect, it } from "vitest";
import { defineTable, type TableDefinition } from "../schema/table";
import { v } from "../schema/values";
import { getPersistentIndexPlan } from "./persistent-index-plan";

describe("getPersistentIndexPlan", () => {
  it("maps logical indexes to the physical indexes used by persistent drivers", () => {
    const tableDef = defineTable("persistentIndexPlan", {
      id: v.string(),
      email: v.string(),
      projectId: v.string(),
    })
      .index("byEmailOrdered", ["email"])
      .index("byEmailUnique", ["email"], { type: "uniqhash" })
      .index("byProject", ["projectId"], { type: "hash" });

    const plan = getPersistentIndexPlan(tableDef);

    expect(plan.physicalIndexes).toEqual([
      {
        name: "byEmailOrdered",
        sortColumns: ["email"],
        unique: true,
        mode: "scan",
      },
      {
        name: "byProject",
        sortColumns: ["projectId", "id"],
        unique: false,
        mode: "scan",
      },
    ]);

    const sharedEmailIndex = plan.physicalIndexes[0];
    expect(plan.byLogicalName.get("byEmailOrdered")).toBe(sharedEmailIndex);
    expect(plan.byLogicalName.get("byEmailUnique")).toBe(sharedEmailIndex);
    expect(plan.byLogicalName.get("byProject")).toBe(plan.physicalIndexes[1]);
    expect(plan.byLogicalName.has("byId")).toBe(false);
  });

  it("caches the complete plan by table definition", () => {
    const tableDef = defineTable("cachedPersistentIndexPlan", {
      id: v.string(),
      title: v.string(),
    }).index("byTitle", ["title"]);

    expect(getPersistentIndexPlan(tableDef)).toBe(
      getPersistentIndexPlan(tableDef),
    );
  });

  it("keeps schemaless indexes separate when their encodings differ", () => {
    const tableDef = {
      tableName: "schemalessPersistentIndexPlan",
      schema: {},
      indexes: {
        byId: { type: "uniqhash", cols: ["id"] },
        byValueOrdered: { type: "btree", cols: ["value"] },
        byValueUnique: { type: "uniqhash", cols: ["value"] },
      },
      idIndexName: "byId",
    } as unknown as TableDefinition;

    const plan = getPersistentIndexPlan(tableDef);

    expect(plan.physicalIndexes).toHaveLength(2);
    expect(plan.byLogicalName.get("byValueOrdered")?.mode).toBe("stored");
    expect(plan.byLogicalName.get("byValueUnique")?.mode).toBe("scan");
    expect(plan.byLogicalName.get("byValueOrdered")).not.toBe(
      plan.byLogicalName.get("byValueUnique"),
    );
  });
});
