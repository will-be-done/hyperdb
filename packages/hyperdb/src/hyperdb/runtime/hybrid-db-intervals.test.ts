import { describe, expect, it, vi } from "vitest";
import { DB } from "./db";
import { HybridDB } from "./hybrid-db";
import {
  boundToInterval,
  canServeLimitedResultFromCache,
  createHybridIntervalCache,
  hasOverlap,
  intervalFromClauses,
  intervalsForLimitedRows,
  isEmptyInterval,
  mergeCoverage,
  mergeCoverageMaps,
  mergeIntervals,
  subtractIntervals,
  subtractOne,
  type NormalizedInterval,
} from "./hybrid-db-intervals";
import { MIN, MAX, type Row } from "../core/primitives";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { AsyncDB } from "../test-utils/async-db";

type Task = {
  id: string;
  title: string;
  value: number;
  projectId: string;
};

const intervalTable = defineTable("hybridIntervalTasks", {
  id: v.string(),
  title: v.string(),
  value: v.number(),
  projectId: v.string(),
})
  .index("byValue", ["value"])
  .index("byProjectValue", ["projectId", "value"])
  .index("byTitle", ["title"], { type: "hash" })
  .index("byIdHash", ["id"], { type: "hash" });

const createTask = (value: number, title = `Task ${value}`): Task => ({
  id: String(value).padStart(3, "0"),
  title,
  value,
  projectId: value <= 3 ? "a" : "b",
});

const createDBs = async () => {
  const primary = new DB(new BptreeInmemDriver());
  const cache = new DB(new BptreeInmemDriver());
  const db = new AsyncDB(new HybridDB(primary, cache));

  await db.loadTables([intervalTable]);

  return { db, primary, cache };
};

const i = (
  lower: NormalizedInterval["lower"],
  upper: NormalizedInterval["upper"],
  lowerInclusive = true,
  upperInclusive = true,
): NormalizedInterval => ({
  lower,
  lowerInclusive,
  upper,
  upperInclusive,
});

describe("HybridDB interval helpers", () => {
  it("normalizes tuple scan bounds into closed and open intervals", () => {
    expect(boundToInterval({ gte: [1], lt: [3] }, 2)).toEqual(
      i([1, MIN], [3, MIN], true, false),
    );
    expect(boundToInterval({ gt: [1], lte: [3] }, 2)).toEqual(
      i([1, MAX], [3, MAX], false, true),
    );
    expect(boundToInterval({}, 2)).toEqual(
      i([MIN, MIN], [MAX, MAX], true, true),
    );
  });

  it("builds interval targets from table indexes", () => {
    expect(
      intervalFromClauses(intervalTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 2 }] },
      ]),
    ).toEqual({
      key: "hybridIntervalTasks:byValue",
      intervals: [i([1, MIN], [2, MAX])],
      indexCols: ["value", "id"],
      supportsPartialLimitCoverage: true,
    });

    expect(
      intervalFromClauses(intervalTable, "byTitle", [
        { eq: [{ col: "title", val: "same" }] },
      ]),
    ).toEqual({
      key: "hybridIntervalTasks:byTitle",
      intervals: [i(["same"], ["same"])],
      indexCols: ["title"],
      supportsPartialLimitCoverage: false,
    });

    expect(
      intervalFromClauses(intervalTable, "byIdHash", [
        { eq: [{ col: "id", val: "001" }] },
      ]).supportsPartialLimitCoverage,
    ).toBe(true);
  });

  it("rejects invalid interval targets and drops impossible intervals", () => {
    expect(() => intervalFromClauses(intervalTable, "byValue", [])).toThrow(
      "scan clauses must be provided",
    );
    expect(() => intervalFromClauses(intervalTable, "missing", [{}])).toThrow(
      "Index not found: missing for table: hybridIntervalTasks",
    );

    expect(
      intervalFromClauses(intervalTable, "byValue", [
        { gt: [{ col: "value", val: 2 }], lte: [{ col: "value", val: 2 }] },
      ]).intervals,
    ).toEqual([]);
  });

  it("detects empty intervals at reversed and exclusive equal boundaries", () => {
    expect(isEmptyInterval(i([3], [2]))).toBe(true);
    expect(isEmptyInterval(i([2], [2], false, true))).toBe(true);
    expect(isEmptyInterval(i([2], [2], true, false))).toBe(true);
    expect(isEmptyInterval(i([2], [2], true, true))).toBe(false);
  });

  it("merges overlapping and touching intervals without mutating input order", () => {
    const intervals = [
      i([5], [6]),
      i([1], [2], true, false),
      i([2], [3], true, true),
      i([3], [4], false, true),
    ];

    expect(mergeIntervals(intervals)).toEqual([
      i([1], [4], true, true),
      i([5], [6]),
    ]);
    expect(intervals[0]).toEqual(i([5], [6]));

    expect(
      mergeIntervals([i([1], [2], true, false), i([2], [3], false, true)]),
    ).toEqual([i([1], [2], true, false), i([2], [3], false, true)]);
  });

  it("handles overlap boundaries with inclusive and exclusive endpoints", () => {
    expect(hasOverlap(i([1], [2], true, false), i([2], [3]))).toBe(false);
    expect(hasOverlap(i([1], [2]), i([2], [3]))).toBe(true);
    expect(hasOverlap(i([1], [2]), i([2], [3], false, true))).toBe(false);
    expect(hasOverlap(i([3], [4]), i([1], [2]))).toBe(false);
  });

  it("subtracts one interval while preserving boundary inclusivity", () => {
    expect(subtractOne(i([1], [5]), i([2], [4]))).toEqual([
      i([1], [2], true, false),
      i([4], [5], false, true),
    ]);

    expect(subtractOne(i([1], [5]), i([2], [4], false, false))).toEqual([
      i([1], [2]),
      i([4], [5]),
    ]);

    expect(subtractOne(i([1], [2], true, false), i([2], [3]))).toEqual([
      i([1], [2], true, false),
    ]);
  });

  it("subtracts multiple covers and merges the remaining gaps", () => {
    expect(
      subtractIntervals([i([1], [10])], [i([2], [3]), i([5], [7])]),
    ).toEqual([
      i([1], [2], true, false),
      i([3], [5], false, false),
      i([7], [10], false, true),
    ]);

    expect(
      subtractIntervals([i([1], [2]), i([2], [3])], [i([1], [3])]),
    ).toEqual([]);
  });

  it("derives cached coverage from ascending limited rows across disjoint intervals", () => {
    const queryIntervals = [i([1], [2]), i([5], [8])];
    const rows = [
      { id: "001", value: 1 },
      { id: "002", value: 2 },
      { id: "006", value: 6 },
    ] satisfies Row[];

    expect(
      intervalsForLimitedRows(queryIntervals, rows, ["value"], "asc"),
    ).toEqual([i([1], [2]), i([5], [6])]);
    expect(
      intervalsForLimitedRows(queryIntervals, [], ["value"], "asc"),
    ).toEqual([]);
  });

  it("derives cached coverage from descending limited rows across disjoint intervals", () => {
    const queryIntervals = [i([1], [2]), i([5], [8])];
    const rows = [
      { id: "008", value: 8 },
      { id: "007", value: 7 },
      { id: "002", value: 2 },
    ] satisfies Row[];

    expect(
      intervalsForLimitedRows(queryIntervals, rows, ["value"], "desc"),
    ).toEqual([i([2], [2]), i([5], [8])]);
  });

  it("decides when a limited result can be satisfied before the first uncovered gap", () => {
    expect(
      canServeLimitedResultFromCache(
        [
          { id: "001", value: 1 },
          { id: "002", value: 2 },
        ],
        2,
        [i([3], [10])],
        ["value"],
        "asc",
      ),
    ).toBe(true);

    expect(
      canServeLimitedResultFromCache(
        [
          { id: "001", value: 1 },
          { id: "003", value: 3 },
        ],
        2,
        [i([3], [10])],
        ["value"],
        "asc",
      ),
    ).toBe(false);

    expect(
      canServeLimitedResultFromCache(
        [
          { id: "010", value: 10 },
          { id: "006", value: 6 },
        ],
        2,
        [i([1], [5])],
        ["value"],
        "desc",
      ),
    ).toBe(true);

    expect(
      canServeLimitedResultFromCache(
        [{ id: "010", value: 10 }],
        2,
        [i([1], [5])],
        ["value"],
        "desc",
      ),
    ).toBe(false);
  });

  it("merges interval coverage maps", () => {
    const parent = createHybridIntervalCache();
    const child = createHybridIntervalCache();

    mergeCoverage(parent, "tasks:byValue", [i([1], [2])]);
    mergeCoverage(child, "tasks:byValue", [i([2], [4], false, true)]);
    mergeCoverage(child, "tasks:byTitle", [i(["a"], ["a"])]);
    mergeCoverageMaps(parent, child);
    mergeCoverage(parent, "tasks:byValue", []);

    expect(parent.get("tasks:byValue")).toEqual([i([1], [4])]);
    expect(parent.get("tasks:byTitle")).toEqual([i(["a"], ["a"])]);
  });
});

describe("HybridDB interval cache edge cases", () => {
  it("caches empty unlimited misses so repeated empty reads stay in memory", async () => {
    const { db, primary } = await createDBs();
    const primaryScanSpy = vi.spyOn(primary, "intervalScan");

    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { eq: [{ col: "value", val: 404 }] },
      ]),
    ).resolves.toEqual([]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { eq: [{ col: "value", val: 404 }] },
      ]),
    ).resolves.toEqual([]);
    expect(primaryScanSpy).not.toHaveBeenCalled();
  });

  it("serves descending limited btree reads from cached coverage", async () => {
    const { db, primary } = await createDBs();
    const primaryScanSpy = vi.spyOn(primary, "intervalScan");
    const tasks = Array.from({ length: 5 }, (_, index) =>
      createTask(index + 1),
    );
    await new AsyncDB(primary).insert(intervalTable, tasks);

    await expect(
      db.intervalScan(
        intervalTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }] }],
        { order: "desc", limit: 2 },
      ),
    ).resolves.toEqual([tasks[4], tasks[3]]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(
        intervalTable,
        "byValue",
        [{ gte: [{ col: "value", val: 1 }] }],
        { order: "desc", limit: 2 },
      ),
    ).resolves.toEqual([tasks[4], tasks[3]]);
    expect(primaryScanSpy).not.toHaveBeenCalled();

    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { gte: [{ col: "value", val: 1 }], lte: [{ col: "value", val: 3 }] },
      ]),
    ).resolves.toEqual(tasks.slice(0, 3));
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });

  it("clears cached interval coverage when tables are reloaded", async () => {
    const { db, primary } = await createDBs();
    const primaryScanSpy = vi.spyOn(primary, "intervalScan");

    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { eq: [{ col: "value", val: 404 }] },
      ]),
    ).resolves.toEqual([]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);

    primaryScanSpy.mockClear();
    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { eq: [{ col: "value", val: 404 }] },
      ]),
    ).resolves.toEqual([]);
    expect(primaryScanSpy).not.toHaveBeenCalled();

    primaryScanSpy.mockClear();
    await db.loadTables([intervalTable]);
    await expect(
      db.intervalScan(intervalTable, "byValue", [
        { eq: [{ col: "value", val: 404 }] },
      ]),
    ).resolves.toEqual([]);
    expect(primaryScanSpy).toHaveBeenCalledTimes(1);
  });
});
