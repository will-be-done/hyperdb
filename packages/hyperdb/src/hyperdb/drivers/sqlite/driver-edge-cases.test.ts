import { describe, expect, it } from "vitest";
import { DB } from "../../runtime/db";
import { SyncDB } from "../../runtime/sync-db";
import {
  defineTable,
  type AnyIndexDefinitions,
  type TableDefinition,
} from "../../schema/table";
import {
  createInspectableSqlDriver,
  createSqlJsDriver,
  type InspectableSqlDatabase,
} from "../../test-utils/sql-js-driver";
import { v } from "../../schema/values";
import { buildSortKeyWhereClause, type SqlValue } from "./sqlite-common";

const noSideTablesTable = defineTable("driverEdgeNoSideTables", {
  id: v.string(),
  title: v.string(),
}).index("byTitle", ["title"]);

const manyPrefixRangesTable = defineTable("driverEdgeManyPrefixRanges", {
  id: v.string(),
  entityId: v.string(),
  tableName: v.string(),
}).index("byEntityAndTable", ["entityId", "tableName"]);

const sharedUniqueOrderedTable = defineTable("driverEdgeSharedUniqueOrdered", {
  id: v.string(),
  email: v.string(),
})
  .index("byEmailOrdered", ["email"])
  .index("byEmailUnique", ["email"], { type: "uniqhash" });

const suffixNamedIndexTable = defineTable("driverEdgeSuffixNamedIndex", {
  id: v.string(),
  title: v.string(),
})
  .index("byTitle_sort_key", ["title"])
  .index("uniqueTitle", ["title"], { type: "uniqhash" });

const sortKeyBackfillTableV1 = defineTable("driverEdgeSortKeyBackfill", {
  id: v.string(),
  title: v.string(),
});

const sortKeyBackfillTableV2 = defineTable("driverEdgeSortKeyBackfill", {
  id: v.string(),
  title: v.string(),
}).index("byTitle", ["title"]);

const pruneSortKeysTableV1 = defineTable("driverEdgePruneSortKeys", {
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
}).index("byTitle", ["title"]);

const pruneSortKeysTableV2 = defineTable("driverEdgePruneSortKeys", {
  id: v.string(),
  title: v.string(),
  state: v.union(v.literal("todo"), v.literal("done")),
}).index("byState", ["state"]);

const uniqhashMigrationTableV1 = defineTable("driverEdgeUniqhashMigration", {
  id: v.string(),
  email: v.string(),
}).index("byEmail", ["email"], { type: "hash" });

const uniqhashMigrationTableV2 = defineTable("driverEdgeUniqhashMigration", {
  id: v.string(),
  email: v.string(),
}).index("byEmail", ["email"], { type: "uniqhash" });

const multiColumnHashTable = {
  tableName: "driverEdgeMultiColumnHash",
  schema: {},
  indexes: {
    byId: { type: "hash", cols: ["id"] },
    byProjectState: { type: "hash", cols: ["projectId", "state"] },
  },
  idIndexName: "byId",
  index() {
    throw new Error("Not used in tests");
  },
} as unknown as TableDefinition<unknown, AnyIndexDefinitions>;

function sqliteRows(sqldb: InspectableSqlDatabase, sql: string): SqlValue[][] {
  return sqldb.exec(sql)[0]?.values ?? [];
}

describe("SQLite driver edge case regressions", () => {
  it("preserves physical indexes whose logical names end in _sort_key", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([suffixNamedIndexTable]);
    db.insert(suffixNamedIndexTable, [
      { id: "task-b", title: "B" },
      { id: "task-a", title: "A" },
    ]);
    execLog.length = 0;

    db.loadTables([suffixNamedIndexTable]);

    expect(execLog.some((sql) => sql.startsWith("DROP INDEX"))).toBe(false);
    expect(
      db
        .intervalScan(suffixNamedIndexTable, "byTitle_sort_key", [{}])
        .map((row) => row.id),
    ).toEqual(["task-a", "task-b"]);
  });

  it("rejects empty primary-key hash bounds", () => {
    expect(() =>
      buildSortKeyWhereClause(
        "byId",
        noSideTablesTable.tableName,
        [],
        new Map([[noSideTablesTable.tableName, noSideTablesTable]]),
      ),
    ).toThrow(/Hash index should have equality conditions/);
  });

  it("backfills sort keys for rows that predate a new index", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([sortKeyBackfillTableV1]);
    db.insert(sortKeyBackfillTableV1, [{ id: "task-a", title: "A" }]);
    execLog.length = 0;

    db.loadTables([sortKeyBackfillTableV2]);

    expect(execLog.some((sql) => sql.startsWith("DELETE FROM"))).toBe(true);
    expect(execLog.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    expect(execLog.some((sql) => sql.startsWith("INSERT OR REPLACE"))).toBe(
      false,
    );
    expect(execLog.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
    expect(
      db.intervalScan(sortKeyBackfillTableV2, "byTitle", [
        { eq: [{ col: "title", val: "A" }] },
      ]),
    ).toEqual([{ id: "task-a", title: "A" }]);
  });

  it("replaces legacy textual sort-key columns with binary sort keys", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);
    db.insert(noSideTablesTable, [{ id: "task-a", title: "A" }]);

    sqldb.run("DROP INDEX idx_driverEdgeNoSideTables_byTitle_sort_key_v2");
    sqldb.run(
      "ALTER TABLE driverEdgeNoSideTables RENAME COLUMN idx_byTitle_sort_key_v2 TO idx_byTitle_sort_key",
    );
    sqldb.run(
      "CREATE INDEX idx_driverEdgeNoSideTables_byTitle_sort_key ON driverEdgeNoSideTables(idx_byTitle_sort_key, id)",
    );

    db.loadTables([noSideTablesTable]);

    const columns = sqliteRows(
      sqldb,
      "PRAGMA table_info(driverEdgeNoSideTables)",
    ).map((row) => String(row[1]));
    expect(columns).not.toContain("idx_byTitle_sort_key");
    expect(columns).toContain("idx_byTitle_sort_key_v2");
    expect(
      sqliteRows(
        sqldb,
        "SELECT typeof(idx_byTitle_sort_key_v2) FROM driverEdgeNoSideTables",
      ),
    ).toEqual([["blob"]]);
    expect(
      db.intervalScan(noSideTablesTable, "byTitle", [
        { eq: [{ col: "title", val: "A" }] },
      ]),
    ).toEqual([{ id: "task-a", title: "A" }]);
  });

  it("recomputes stored sort keys when a hash index is promoted to uniqhash", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));

    db.loadTables([uniqhashMigrationTableV1]);
    db.insert(uniqhashMigrationTableV1, [
      { id: "task-a", email: "a@example.com" },
      { id: "task-b", email: "b@example.com" },
    ]);

    db.loadTables([uniqhashMigrationTableV2]);

    // The generated index is rebuilt as UNIQUE.
    const byEmail = sqliteRows(
      sqldb,
      "PRAGMA index_list(driverEdgeUniqhashMigration)",
    ).find(
      (row) =>
        String(row[1]) ===
        "idx_driverEdgeUniqhashMigration_byEmail_sort_key_v2",
    );
    expect(byEmail && Number(byEmail[2])).toBe(1);

    // The pre-migration row is still found by an equality lookup, which only
    // works if its stored sort key was re-encoded from [email, id] to [email].
    expect(
      db.intervalScan(uniqhashMigrationTableV2, "byEmail", [
        { eq: [{ col: "email", val: "a@example.com" }] },
      ]),
    ).toEqual([{ id: "task-a", email: "a@example.com" }]);

    // The new UNIQUE constraint rejects a different row with the same value.
    expect(() =>
      db.insert(uniqhashMigrationTableV2, [
        { id: "task-c", email: "a@example.com" },
      ]),
    ).toThrow();
  });

  it("drops sort-key indexes and columns that are no longer in the schema", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));

    db.loadTables([pruneSortKeysTableV1]);
    db.insert(pruneSortKeysTableV1, [
      { id: "task-a", title: "A", state: "todo" },
      { id: "task-b", title: "B", state: "done" },
    ]);

    db.loadTables([pruneSortKeysTableV2]);

    const columns = sqliteRows(
      sqldb,
      "PRAGMA table_info(driverEdgePruneSortKeys)",
    ).map((row) => String(row[1]));
    expect(columns).toEqual(["id", "data", "idx_byState_sort_key_v2"]);

    const indexNames = sqliteRows(
      sqldb,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'driverEdgePruneSortKeys'",
    ).map(([name]) => String(name));
    expect(indexNames).toContain(
      "idx_driverEdgePruneSortKeys_byState_sort_key_v2",
    );
    expect(indexNames).not.toContain(
      "idx_driverEdgePruneSortKeys_byTitle_sort_key_v2",
    );

    expect(
      db.intervalScan(pruneSortKeysTableV2, "byState", [
        { eq: [{ col: "state", val: "done" }] },
      ]),
    ).toEqual([{ id: "task-b", title: "B", state: "done" }]);
  });

  it("supports tuple equality bounds for direct multi-column hash definitions", async () => {
    const db = new SyncDB(new DB(await createSqlJsDriver()));
    db.loadTables([multiColumnHashTable]);
    db.insert(multiColumnHashTable, [
      { id: "task-a", projectId: "project-1", state: "open" },
      { id: "task-b", projectId: "project-1", state: "done" },
    ]);

    expect(
      db.intervalScan(multiColumnHashTable, "byProjectState", [
        {
          eq: [
            { col: "projectId", val: "project-1" },
            { col: "state", val: "open" },
          ],
        },
      ]),
    ).toEqual([{ id: "task-a", projectId: "project-1", state: "open" }]);
  });

  it("uses the primary key for multiple exact ID lookups", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);
    db.insert(noSideTablesTable, [
      { id: "task-a", title: "A" },
      { id: "task-b", title: "B" },
      { id: "task-c", title: "C" },
    ]);
    execLog.length = 0;

    expect(
      db
        .intervalScan(noSideTablesTable, "byId", [
          { eq: [{ col: "id", val: "task-a" }] },
          { eq: [{ col: "id", val: "task-c" }] },
        ])
        .map((row) => row.id),
    ).toEqual(["task-a", "task-c"]);

    const selectSql = execLog.find((sql) =>
      sql.includes("FROM driverEdgeNoSideTables"),
    );
    expect(selectSql).toContain("WHERE id IN (?, ?)");
    expect(selectSql).not.toContain(" OR ");
  });

  it("supports many exact-prefix ranges without exceeding SQLite expression depth", async () => {
    const db = new SyncDB(new DB(await createSqlJsDriver()));
    db.loadTables([manyPrefixRangesTable]);

    const rows = Array.from({ length: 400 }, (_, index) => ({
      id: `change-${index}`,
      entityId: `entity-${index}`,
      tableName: "tasks",
    }));
    db.insert(manyPrefixRangesTable, rows);

    const results = db.intervalScan(
      manyPrefixRangesTable,
      "byEntityAndTable",
      rows.map((row) => ({
        eq: [
          { col: "entityId", val: row.entityId },
          { col: "tableName", val: row.tableName },
        ],
      })),
    );

    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
  });

  it("shares one physical index between matching uniqhash and B-tree indexes", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([sharedUniqueOrderedTable]);
    db.insert(sharedUniqueOrderedTable, [
      { id: "user-b", email: "b@example.com" },
      { id: "user-a", email: "a@example.com" },
    ]);

    expect(
      db.intervalScan(sharedUniqueOrderedTable, "byEmailUnique", [
        { eq: [{ col: "email", val: "a@example.com" }] },
      ]),
    ).toEqual([{ id: "user-a", email: "a@example.com" }]);
    expect(
      db.intervalScan(sharedUniqueOrderedTable, "byEmailOrdered", [{}]),
    ).toEqual([
      { id: "user-a", email: "a@example.com" },
      { id: "user-b", email: "b@example.com" },
    ]);

    const columns = sqliteRows(
      sqldb,
      "PRAGMA table_info(driverEdgeSharedUniqueOrdered)",
    ).map((row) => String(row[1]));
    expect(columns).toEqual(["id", "data", "idx_byEmailOrdered_sort_key_v2"]);

    const generatedIndexes = sqliteRows(
      sqldb,
      "PRAGMA index_list(driverEdgeSharedUniqueOrdered)",
    ).filter((row) => String(row[1]).startsWith("idx_"));
    expect(generatedIndexes).toHaveLength(1);
    expect(String(generatedIndexes[0]?.[1])).toBe(
      "idx_driverEdgeSharedUniqueOrdered_byEmailOrdered_sort_key_v2",
    );
    expect(Number(generatedIndexes[0]?.[2])).toBe(1);

    expect(() =>
      db.insert(sharedUniqueOrderedTable, [
        { id: "user-c", email: "a@example.com" },
      ]),
    ).toThrow();
  });

  it("chunks inserts by SQLite bind variable budget", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);
    execLog.length = 0;

    db.insert(
      noSideTablesTable,
      Array.from({ length: 301 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
      })),
    );

    const inserts = execLog.filter((sql) =>
      sql.startsWith("INSERT INTO driverEdgeNoSideTables"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.match(/\?/g)).toHaveLength(900);
    expect(inserts[1]!.match(/\?/g)).toHaveLength(3);
  });

  it("stores index sort keys on the base table and scans without side-index tables", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);
    db.insert(noSideTablesTable, [
      { id: "task-c", title: "C" },
      { id: "task-a", title: "A" },
      { id: "task-b", title: "B" },
    ]);

    const tableNames = sqliteRows(
      sqldb,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map(([name]) => String(name));
    expect(tableNames).toEqual(["driverEdgeNoSideTables"]);
    expect(tableNames.some((name) => name.endsWith("__idx"))).toBe(false);

    const columns = sqliteRows(
      sqldb,
      "PRAGMA table_info(driverEdgeNoSideTables)",
    ).map((row) => String(row[1]));
    expect(columns).toEqual(["id", "data", "idx_byTitle_sort_key_v2"]);

    const indexSql = sqliteRows(
      sqldb,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'driverEdgeNoSideTables'",
    ).map(([sql]) => String(sql));
    expect(
      indexSql.some((sql) =>
        sql.includes("ON driverEdgeNoSideTables(idx_byTitle_sort_key_v2, id)"),
      ),
    ).toBe(true);
    expect(
      indexSql.some((sql) =>
        sql.includes("WHERE idx_byTitle_sort_key_v2 IS NOT NULL"),
      ),
    ).toBe(true);

    expect(
      db
        .intervalScan(noSideTablesTable, "byTitle", [{}], { limit: 2 })
        .map((row) => row.id),
    ).toEqual(["task-a", "task-b"]);
  });
});
