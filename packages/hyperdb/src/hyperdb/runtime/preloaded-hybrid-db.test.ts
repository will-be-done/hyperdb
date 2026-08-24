import { describe, expect, it, vi } from "vitest";
import { DB } from "./db";
import { PreloadedHybridDB } from "./preloaded-hybrid-db";
import { PreloadedTableIndexes } from "./preloaded-hybrid-db-indexes";
import { AsyncDB } from "../test-utils/async-db";
import { createSqlJsDriver } from "../test-utils/sql-js-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { execAsync } from "../core/executor";

const tasksTable = defineTable("preloadedHybridTasks", {
  id: v.string(),
  title: v.string(),
  value: v.number(),
  slug: v.string(),
})
  .index("byValue", ["value"])
  .index("byTitle", ["title"], { type: "hash" })
  .index("bySlug", ["slug"], { type: "uniqhash" });

const projectsTable = defineTable("preloadedHybridProjects", {
  id: v.string(),
  title: v.string(),
});

type Task = {
  id: string;
  title: string;
  value: number;
  slug: string;
};

const task = (value: number, title = `Task ${value}`): Task => ({
  id: String(value).padStart(3, "0"),
  title,
  value,
  slug: `task-${value}`,
});

async function createRuntime(rows: Task[]) {
  const primary = new DB(await createSqlJsDriver());
  const primaryDB = new AsyncDB(primary);
  await primaryDB.loadTables([tasksTable, projectsTable]);
  await primaryDB.insert(tasksTable, rows);
  await primaryDB.insert(projectsTable, [{ id: "p1", title: "Project" }]);

  const scanAllSpy = vi.spyOn(primary, "scanAll");
  const intervalScanSpy = vi.spyOn(primary, "intervalScan");
  const runtime = new PreloadedHybridDB(primary);
  const db = new AsyncDB(runtime);
  await db.loadTables([tasksTable, projectsTable]);

  return { db, runtime, primary, scanAllSpy, intervalScanSpy };
}

describe("PreloadedHybridDB", () => {
  it("preloads every table index without retaining entity rows", async () => {
    const rows = [task(1, "same"), task(2, "same"), task(3, "other")];
    const { db, scanAllSpy, intervalScanSpy } = await createRuntime(rows);

    expect(scanAllSpy).toHaveBeenCalledTimes(2);
    expect(intervalScanSpy).not.toHaveBeenCalled();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual(rows.slice(0, 2));
    expect(intervalScanSpy).toHaveBeenCalledTimes(1);
    expect(intervalScanSpy.mock.calls[0]?.[1]).toBe("byId");
    expect(intervalScanSpy.mock.calls[0]?.[2]).toEqual([
      { eq: [{ col: "id", val: "001" }] },
      { eq: [{ col: "id", val: "002" }] },
    ]);

    intervalScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).resolves.toEqual(rows.slice(0, 2));
    await expect(
      db.intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: "task-1" }] },
      ]),
    ).resolves.toEqual([rows[0]]);
    expect(intervalScanSpy).not.toHaveBeenCalled();

    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
      ]),
    ).resolves.toEqual(rows);
    expect(intervalScanSpy).toHaveBeenCalledTimes(1);
    expect(intervalScanSpy.mock.calls[0]?.[2]).toEqual([
      { eq: [{ col: "id", val: "003" }] },
    ]);
  });

  it("supports tables whose only declared index is the built-in byId", async () => {
    const { db, intervalScanSpy } = await createRuntime([task(1)]);

    await expect(
      db.intervalScan(projectsTable, "byId", [
        { eq: [{ col: "id", val: "p1" }] },
      ]),
    ).resolves.toEqual([{ id: "p1", title: "Project" }]);
    expect(intervalScanSpy).toHaveBeenCalledTimes(1);
    expect(intervalScanSpy.mock.calls[0]?.[1]).toBe("byId");
  });

  it("uses the built-in byId hash index as the canonical entity cache", async () => {
    const first = task(1);
    const second = task(2);
    const { db, runtime } = await createRuntime([first, second]);
    const internal = runtime as unknown as {
      state: {
        data: {
          tables: Map<
            string,
            {
              byId: {
                values(): Array<
                  | { id: string; loaded: false }
                  | { id: string; loaded: true; row: Task }
                >;
              };
            }
          >;
        };
      };
    };
    const byId = internal.state.data.tables.get(tasksTable.tableName)?.byId;

    expect(
      byId?.values().sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: first.id, loaded: false },
      { id: second.id, loaded: false },
    ]);

    await db.intervalScan(tasksTable, "bySlug", [
      { eq: [{ col: "slug", val: first.slug }] },
    ]);

    expect(
      byId?.values().sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: first.id, loaded: true, row: first },
      { id: second.id, loaded: false },
    ]);
  });

  it("reconciles exact byId misses written by another runtime", async () => {
    const { db, primary, intervalScanSpy } = await createRuntime([]);
    const external = task(7, "external");
    await execAsync(primary.insert(tasksTable, [external]));
    intervalScanSpy.mockClear();

    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: external.id }] },
      ]),
    ).resolves.toEqual([external]);
    expect(intervalScanSpy).toHaveBeenCalledTimes(1);

    intervalScanSpy.mockClear();
    await expect(
      db.intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: external.slug }] },
      ]),
    ).resolves.toEqual([external]);
    expect(intervalScanSpy).not.toHaveBeenCalled();
  });

  it("keeps B-tree ordering and limits while hydrating only selected IDs", async () => {
    const rows = [task(1), task(2), task(3), task(4)];
    const { db, intervalScanSpy } = await createRuntime(rows);

    await expect(
      db.intervalScan(tasksTable, "byValue", [{}], {
        order: "desc",
        limit: 2,
      }),
    ).resolves.toEqual([rows[3], rows[2]]);
    expect(intervalScanSpy.mock.calls[0]?.[2]).toEqual([
      { eq: [{ col: "id", val: "004" }] },
      { eq: [{ col: "id", val: "003" }] },
    ]);
  });

  it("updates preloaded indexes and the entity cache on writes", async () => {
    const original = task(1);
    const { db, intervalScanSpy } = await createRuntime([original]);
    intervalScanSpy.mockClear();

    const inserted = task(2, "new");
    await db.insert(tasksTable, [inserted]);
    await expect(
      db.intervalScan(tasksTable, "byTitle", [
        { eq: [{ col: "title", val: "new" }] },
      ]),
    ).resolves.toEqual([inserted]);

    const updated = { ...original, title: "updated", value: 10 };
    await db.upsert(tasksTable, [updated]);
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 10 }] },
      ]),
    ).resolves.toEqual([updated]);
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([]);

    await db.delete(tasksTable, [inserted.id]);
    await expect(
      db.intervalScan(tasksTable, "byId", [
        { eq: [{ col: "id", val: inserted.id }] },
      ]),
    ).resolves.toEqual([]);
    expect(intervalScanSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes committed transaction index changes and discards rollbacks", async () => {
    const original = task(1);
    const { db } = await createRuntime([original]);

    const rollbackTx = await db.beginTx();
    await rollbackTx.upsert(tasksTable, [{ ...original, value: 2 }]);
    await expect(
      rollbackTx.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 2 }] },
      ]),
    ).resolves.toEqual([{ ...original, value: 2 }]);
    await rollbackTx.rollback();
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 1 }] },
      ]),
    ).resolves.toEqual([original]);

    const commitTx = await db.beginTx();
    const committed = { ...original, value: 3 };
    await commitTx.upsert(tasksTable, [committed]);
    await commitTx.commit();
    await expect(
      db.intervalScan(tasksTable, "byValue", [
        { eq: [{ col: "value", val: 3 }] },
      ]),
    ).resolves.toEqual([committed]);
  });

  it("rejects writes through readonly transactions", async () => {
    const original = task(1);
    const { runtime } = await createRuntime([original]);
    const tx = await execAsync(runtime.beginTx("readonly"));
    try {
      await expect(
        execAsync(tx.upsert(tasksTable, [{ ...original, value: 2 }])),
      ).rejects.toThrow("Cannot write through a readonly transaction");
    } finally {
      await execAsync(tx.rollback());
    }
  });

  it("supports swapping unique values in one upsert batch", async () => {
    const first = task(1);
    const second = task(2);
    const { db } = await createRuntime([first, second]);
    const swapped = [
      { ...first, slug: second.slug },
      { ...second, slug: first.slug },
    ];

    await db.upsert(tasksTable, swapped);
    await expect(
      db.intervalScan(tasksTable, "bySlug", [
        { eq: [{ col: "slug", val: first.slug }] },
      ]),
    ).resolves.toEqual([swapped[1]]);
  });

  it("stores entity IDs, not rows, in B-tree and hash index leaves", () => {
    const indexes = new PreloadedTableIndexes(tasksTable, [
      task(1, "same"),
      task(2, "same"),
    ]);
    const internal = indexes as unknown as {
      indexes: Map<
        string,
        {
          tree?: { nodes: Map<string, { leaf: boolean; values?: unknown[] }> };
          index?: { buckets: Map<string, Map<string, unknown>> };
        }
      >;
    };

    const btree = internal.indexes.get("byValue")?.tree;
    const btreeLeafValues = Array.from(btree?.nodes.values() ?? [])
      .filter((node) => node.leaf)
      .flatMap((node) => node.values ?? []) as { value: unknown }[];
    expect(btreeLeafValues.map((entry) => entry.value)).toEqual(["001", "002"]);

    const hashBuckets = internal.indexes.get("byTitle")?.index.buckets;
    expect(
      Array.from(hashBuckets?.values() ?? []).flatMap((bucket) => [
        ...bucket.values(),
      ]),
    ).toEqual(["001", "002"]);
  });
});
