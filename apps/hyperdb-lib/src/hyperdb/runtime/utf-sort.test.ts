import { describe, expect, it } from "vitest";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { DB } from "./db";
import { AsyncDB } from "../test-utils/async-db";
import { createDriverFactories } from "../test-utils/driver-factories";

const utfStringsTable = defineTable("utfSortStrings", {
  id: v.string(),
  value: v.string(),
}).index("byValue", ["value"]);

const rows = [
  { id: "bmp-max", value: "\uffff" },
  { id: "private-use-start", value: "\ue000" },
  { id: "deseret", value: "𐀀" },
  { id: "grinning", value: "😀" },
  { id: "smiley", value: "😃" },
  { id: "plain-a", value: "a" },
  { id: "plain-aa", value: "aa" },
  { id: "a-grinning", value: "a😀" },
  { id: "a-bmp-max", value: "a\uffff" },
];

const idsByJsStringOrder = [...rows]
  .sort((left, right) => (left.value > right.value ? 1 : -1))
  .map((row) => row.id);

describe("utf string sorting", async () => {
  for (const [driverName, createDriver] of createDriverFactories()) {
    it(`orders indexed UTF strings like JavaScript for ${driverName}`, async () => {
      const db = new AsyncDB(new DB(await createDriver()));
      await db.loadTables([utfStringsTable]);
      await db.insert(utfStringsTable, rows);

      expect(
        (await db.intervalScan(utfStringsTable, "byValue", [{}])).map(
          (row) => row.id,
        ),
      ).toEqual(idsByJsStringOrder);

      expect(
        (
          await db.intervalScan(utfStringsTable, "byValue", [{}], {
            order: "desc",
          })
        ).map((row) => row.id),
      ).toEqual([...idsByJsStringOrder].reverse());
    });

    it(`uses JavaScript UTF string order for range bounds in ${driverName}`, async () => {
      const db = new AsyncDB(new DB(await createDriver()));
      await db.loadTables([utfStringsTable]);
      await db.insert(utfStringsTable, rows);

      expect(
        (
          await db.intervalScan(utfStringsTable, "byValue", [
            { gte: [{ col: "value", val: "𐀀" }] },
          ])
        ).map((row) => row.id),
      ).toEqual([
        "deseret",
        "grinning",
        "smiley",
        "private-use-start",
        "bmp-max",
      ]);

      expect(
        (
          await db.intervalScan(utfStringsTable, "byValue", [
            { lt: [{ col: "value", val: "\ue000" }] },
          ])
        ).map((row) => row.id),
      ).toEqual([
        "plain-a",
        "plain-aa",
        "a-grinning",
        "a-bmp-max",
        "deseret",
        "grinning",
        "smiley",
      ]);
    });
  }
});
