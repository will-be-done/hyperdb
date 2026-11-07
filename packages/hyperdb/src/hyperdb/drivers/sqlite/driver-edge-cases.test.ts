import { describe, expect, it } from "vitest";
import { DB } from "../../runtime/db";
import { SyncDB } from "../../runtime/sync-db";
import {
  defineTable,
  type AnyIndexDefinitions,
  type TableDefinition,
} from "../../schema/table";
import {
  createInspectableSqlAsyncDriver,
  createInspectableSqlDriver,
  createSqlJsAsyncDriver,
  createSqlJsDriver,
  createSqlJsDriverFromDatabase,
  type InspectableSqlDatabase,
} from "../../test-utils/sql-js-driver";
import { v } from "../../schema/values";
import { execAsync, execSync } from "../../core/executor";
import { DuplicateIdError, HyperDBError } from "../../core/errors";
import { createTursoWasmDriver } from "../../test-utils/turso-wasm-driver";
import type { DBDriver } from "../../core/driver";
import type { DBCmd } from "../../commands/async";
import {
  buildSortKeyWhereClause,
  SQLITE_SCHEMA_METADATA_TABLE,
  type SqlValue,
} from "./sqlite-common";

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

const indexColumnsTableV1 = defineTable("driverEdgeIndexColumns", {
  id: v.string(),
  title: v.string(),
  state: v.string(),
}).index("byKey", ["title"]);

const indexColumnsTableV2 = defineTable("driverEdgeIndexColumns", {
  id: v.string(),
  title: v.string(),
  state: v.string(),
}).index("byKey", ["state"]);

const lowerCaseTable = defineTable("driverEdgeCaseName", {
  id: v.string(),
});

const upperCaseTable = defineTable("DRIVEREDGECASENAME", {
  id: v.string(),
});

function schemalessTable(
  tableName: string,
  indexes: Record<string, { type: "hash" | "btree"; cols: string[] }>,
): TableDefinition<unknown, AnyIndexDefinitions> {
  return {
    tableName,
    schema: {},
    indexes: { byId: { type: "hash", cols: ["id"] }, ...indexes },
    idIndexName: "byId",
    index() {
      throw new Error("Not used in tests");
    },
  } as unknown as TableDefinition<unknown, AnyIndexDefinitions>;
}

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
  it("uses one metadata read when loaded table schemas are unchanged", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));

    db.loadTables([noSideTablesTable]);
    execLog.length = 0;
    db.loadTables([noSideTablesTable]);

    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toContain(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`);
    expect(execLog[0]).not.toContain("BEGIN TRANSACTION");
  });

  it("initializes schema metadata when the adapter hides missing-table details", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    let obscureMetadataReadError = true;
    const { driver, execLog } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforePrepare(sql) {
        if (
          obscureMetadataReadError &&
          sql.includes(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`)
        ) {
          throw new Error("statement preparation failed");
        }
      },
    });
    const db = new SyncDB(new DB(driver));

    db.loadTables([noSideTablesTable]);
    expect(
      sqliteRows(
        sqldb,
        `SELECT name FROM sqlite_schema WHERE name = '${SQLITE_SCHEMA_METADATA_TABLE}'`,
      ),
    ).toEqual([[SQLITE_SCHEMA_METADATA_TABLE]]);

    expect(() => db.loadTables([noSideTablesTable])).toThrow(
      "statement preparation failed",
    );

    obscureMetadataReadError = false;
    execLog.length = 0;
    db.loadTables([noSideTablesTable]);
    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toContain(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`);
  });

  it("keeps the metadata-read error when the fallback inspection also fails", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    let failReads = false;
    const { driver } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforePrepare(sql) {
        if (!failReads) return;
        if (sql.includes(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`)) {
          throw new Error("metadata read failed");
        }
        if (sql.includes("FROM sqlite_schema")) {
          throw new Error("inspection failed");
        }
      },
    });
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);

    failReads = true;
    expect(() => db.loadTables([noSideTablesTable])).toThrow(
      "metadata read failed",
    );
  });

  it("releases the transaction slot when BEGIN fails", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    let failBegin = false;
    const { driver } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforeExec(sql) {
        if (failBegin && sql === "BEGIN TRANSACTION") {
          throw new Error("begin failed");
        }
      },
    });
    execSync(driver.loadTables([noSideTablesTable]));

    failBegin = true;
    expect(() => execSync(driver.beginTx())).toThrow("begin failed");

    failBegin = false;
    const tx = execSync(driver.beginTx());
    execSync(tx.insert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]));
    execSync(tx.commit());
    expect(
      execSync(
        driver.intervalScan(noSideTablesTable.tableName, "byTitle", [{}], {}),
      ),
    ).toEqual([{ id: "a", title: "A" }]);
  });

  it("rejects driver operations while a sync transaction is open", async () => {
    const driver = await createSqlJsDriver();
    execSync(driver.loadTables([noSideTablesTable]));
    const tx = execSync(driver.beginTx());

    const operations: (() => Generator<DBCmd, unknown>)[] = [
      () => driver.insert(noSideTablesTable.tableName, [{ id: "a" }]),
      () =>
        driver.intervalScan(noSideTablesTable.tableName, "byTitle", [{}], {}),
      () => driver.loadTables([noSideTablesTable]),
      () => driver.beginTx(),
    ];
    for (const run of operations) {
      expect(() => execSync(run())).toThrow(
        "can't run while transaction is in progress",
      );
    }

    execSync(tx.rollback());
    expect(() => execSync(tx.commit())).toThrow("Transaction already finished");
  });

  it("rejects table names that differ only in case", async () => {
    const driver = await createSqlJsDriver();

    expect(() =>
      execSync(driver.loadTables([lowerCaseTable, upperCaseTable])),
    ).toThrow("SQLite table names are case-insensitive");

    execSync(driver.loadTables([lowerCaseTable]));
    expect(() => execSync(driver.loadTables([upperCaseTable]))).toThrow(
      "SQLite table names are case-insensitive",
    );
    // Reloading the same name is fine.
    execSync(driver.loadTables([lowerCaseTable]));
  });

  it("frees the driver when SQLite already rolled the transaction back", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    execSync(driver.loadTables([noSideTablesTable]));
    const tx = execSync(driver.beginTx());
    execSync(tx.insert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]));
    // What SQLite does on its own after errors such as a full disk.
    sqldb.run("ROLLBACK");

    execSync(tx.rollback());

    execSync(driver.insert(noSideTablesTable.tableName, [{ id: "b" }]));
    expect(execSync(driver.scanAll(noSideTablesTable.tableName))).toEqual([
      { id: "b" },
    ]);
  });

  it("refuses the connection after a transaction rollback fails", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    let failRollback = false;
    const { driver } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforeExec(sql) {
        if (failRollback && sql === "ROLLBACK") {
          throw new Error("rollback failed");
        }
      },
    });
    execSync(driver.loadTables([noSideTablesTable]));
    const tx = execSync(driver.beginTx());
    execSync(tx.insert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]));

    failRollback = true;
    expect(() => execSync(tx.rollback())).toThrow("rollback failed");

    // The uncommitted row must not be readable through the driver.
    expect(() => execSync(driver.scanAll(noSideTablesTable.tableName))).toThrow(
      "SQLite connection is unusable",
    );
    expect(() => execSync(driver.beginTx())).toThrow(
      "SQLite connection is unusable",
    );
  });

  it("refuses the connection after a failed write cannot be rolled back", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    let failWrites = false;
    const { driver } = createSqlJsDriverFromDatabase(sqldb, [], {
      beforeExec(sql) {
        if (!failWrites) return;
        if (sql.startsWith("INSERT INTO")) throw new Error("insert failed");
        if (sql === "ROLLBACK") throw new Error("rollback failed");
      },
    });
    execSync(driver.loadTables([noSideTablesTable]));

    failWrites = true;
    // The caller gets the write's error, not the rollback's.
    expect(() =>
      execSync(
        driver.upsert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]),
      ),
    ).toThrow("insert failed");

    failWrites = false;
    let error: unknown;
    try {
      execSync(driver.scanAll(noSideTablesTable.tableName));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("SQLite connection is unusable");
    expect((error as Error).cause).toEqual(new Error("rollback failed"));
  });

  it("recomputes sort keys when an index keeps its name but changes columns", async () => {
    const driver = await createSqlJsDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([indexColumnsTableV1]);
    db.insert(indexColumnsTableV1, [
      { id: "task-a", title: "A", state: "done" },
      { id: "task-b", title: "B", state: "todo" },
    ]);

    db.loadTables([indexColumnsTableV2]);

    expect(
      db.intervalScan(indexColumnsTableV2, "byKey", [
        { eq: [{ col: "state", val: "todo" }] },
      ]),
    ).toEqual([{ id: "task-b", title: "B", state: "todo" }]);
    expect(
      db.intervalScan(indexColumnsTableV2, "byKey", [{}]).map((row) => row.id),
    ).toEqual(["task-a", "task-b"]);
  });

  it("recomputes every sort key when the stored signature is missing", async () => {
    const { driver, sqldb } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);
    db.insert(noSideTablesTable, [
      { id: "task-a", title: "A" },
      { id: "task-b", title: "B" },
    ]);
    // Nothing records how these keys were encoded.
    sqldb.run(
      "UPDATE driverEdgeNoSideTables SET idx_byTitle_sort_key_v2 = x'00'",
    );
    sqldb.run(`DELETE FROM ${SQLITE_SCHEMA_METADATA_TABLE}`);

    db.loadTables([noSideTablesTable]);

    expect(
      db.intervalScan(noSideTablesTable, "byTitle", [
        { eq: [{ col: "title", val: "B" }] },
      ]),
    ).toEqual([{ id: "task-b", title: "B" }]);
  });

  it("backfills sort keys page by page past rows that stay out of the index", async () => {
    const tableV1 = schemalessTable("driverEdgeBackfillPages", {});
    const tableV2 = schemalessTable("driverEdgeBackfillPages", {
      byTitle: { type: "hash", cols: ["title"] },
    });
    const { driver, sqldb, execLog } = await createInspectableSqlDriver();
    execSync(driver.loadTables([tableV1]));
    // More rows than one page, and every other row has no title, so it
    // keeps a NULL sort key after the backfill.
    const rows = Array.from({ length: 12_500 }, (_, index) => {
      const id = `row-${String(index).padStart(5, "0")}`;
      return index % 2 ? { id } : { id, title: `title-${index}` };
    });
    execSync(driver.insert(tableV1.tableName, rows));
    execLog.length = 0;

    execSync(driver.loadTables([tableV2]));

    expect(
      execLog.filter((sql) => sql.startsWith("SELECT id, data FROM")),
    ).toHaveLength(2);
    expect(
      sqliteRows(
        sqldb,
        "SELECT count(idx_byTitle_sort_key_v2) FROM driverEdgeBackfillPages",
      ),
    ).toEqual([[6_250]]);
  });

  it("refreshes per-table metadata after another table changes the schema", async () => {
    const { driver, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));

    db.loadTables([noSideTablesTable]);
    db.loadTables([manyPrefixRangesTable]);

    execLog.length = 0;
    db.loadTables([noSideTablesTable]);
    expect(execLog).toContain("BEGIN TRANSACTION");

    execLog.length = 0;
    db.loadTables([noSideTablesTable]);
    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toContain(`LEFT JOIN ${SQLITE_SCHEMA_METADATA_TABLE}`);
  });

  it("repairs an externally dropped index despite matching table signatures", async () => {
    const { driver, sqldb, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);

    sqldb.run("DROP INDEX idx_driverEdgeNoSideTables_byTitle_sort_key_v2");
    execLog.length = 0;
    db.loadTables([noSideTablesTable]);

    expect(execLog).toContain("BEGIN TRANSACTION");
    expect(
      execLog.some((sql) =>
        sql.startsWith(
          "CREATE INDEX IF NOT EXISTS idx_driverEdgeNoSideTables_byTitle_sort_key_v2",
        ),
      ),
    ).toBe(true);
    expect(
      sqliteRows(sqldb, "PRAGMA index_list(driverEdgeNoSideTables)").some(
        (row) =>
          String(row[1]) === "idx_driverEdgeNoSideTables_byTitle_sort_key_v2",
      ),
    ).toBe(true);
  });

  it("treats SQLite index identifiers as case-insensitive", async () => {
    const { driver, sqldb, execLog } = await createInspectableSqlDriver();
    const db = new SyncDB(new DB(driver));
    db.loadTables([noSideTablesTable]);

    sqldb.run("DROP INDEX idx_driverEdgeNoSideTables_byTitle_sort_key_v2");
    sqldb.run(
      "CREATE INDEX idx_driveredgenosidetables_bytitle_sort_key_v2 ON driverEdgeNoSideTables(idx_byTitle_sort_key_v2, id) WHERE idx_byTitle_sort_key_v2 IS NOT NULL",
    );
    execLog.length = 0;

    db.loadTables([noSideTablesTable]);

    expect(execLog.some((sql) => sql.startsWith("DROP INDEX"))).toBe(false);
    expect(
      sqliteRows(sqldb, "PRAGMA index_list(driverEdgeNoSideTables)").some(
        (row) =>
          String(row[1]) === "idx_driveredgenosidetables_bytitle_sort_key_v2",
      ),
    ).toBe(true);
  });

  it("commits schema metadata only after reconciliation succeeds", async () => {
    const { sqldb } = await createInspectableSqlDriver();
    const initialDb = new SyncDB(
      new DB(createSqlJsDriverFromDatabase(sqldb).driver),
    );
    initialDb.loadTables([sortKeyBackfillTableV1]);
    const metadataBefore = sqliteRows(
      sqldb,
      `SELECT table_name, signature, verified_schema_version FROM ${SQLITE_SCHEMA_METADATA_TABLE}`,
    );

    const failingDriver = createSqlJsDriverFromDatabase(sqldb, [], {
      beforeExec(sql) {
        if (sql.includes("ADD COLUMN idx_byTitle_sort_key_v2")) {
          throw new Error("injected schema failure");
        }
      },
    }).driver;
    const failingDb = new SyncDB(new DB(failingDriver));

    expect(() => failingDb.loadTables([sortKeyBackfillTableV2])).toThrow(
      "injected schema failure",
    );
    expect(
      sqliteRows(
        sqldb,
        `SELECT table_name, signature, verified_schema_version FROM ${SQLITE_SCHEMA_METADATA_TABLE}`,
      ),
    ).toEqual(metadataBefore);

    const recoveredDb = new SyncDB(
      new DB(createSqlJsDriverFromDatabase(sqldb).driver),
    );
    recoveredDb.loadTables([sortKeyBackfillTableV2]);
    expect(
      sqliteRows(sqldb, "PRAGMA table_info(driverEdgeSortKeyBackfill)").some(
        (row) => String(row[1]) === "idx_byTitle_sort_key_v2",
      ),
    ).toBe(true);
  });

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
    expect(tableNames).toEqual([
      SQLITE_SCHEMA_METADATA_TABLE,
      "driverEdgeNoSideTables",
    ]);
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

  it("commits only after the transaction's in-flight write finishes", async () => {
    const { driver, execLog } = await createInspectableSqlAsyncDriver();
    await execAsync(driver.loadTables([noSideTablesTable]));
    const tx = await execAsync(driver.beginTx());
    execLog.length = 0;

    // Neither is awaited before the other starts.
    const write = execAsync(
      tx.upsert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]),
    );
    const commit = execAsync(tx.commit());
    await Promise.all([write, commit]);

    expect(execLog.at(-1)).toBe("COMMIT");
    expect(
      await execAsync(driver.scanAll(noSideTablesTable.tableName)),
    ).toEqual([{ id: "a", title: "A" }]);
  });

  const sqliteDrivers: [string, () => Promise<DBDriver>][] = [
    ["SqlDriver", createSqlJsDriver],
    ["AsyncSqlDriver (sql.js)", () => createSqlJsAsyncDriver()],
    ["AsyncSqlDriver (Turso WASM)", () => createTursoWasmDriver()],
  ];

  for (const [name, createDriver] of sqliteDrivers) {
    describe(`${name} duplicate ids`, () => {
      const usersTable = defineTable("driverEdgeDuplicateUsers", {
        id: v.string(),
        email: v.string(),
      }).index("byEmail", ["email"], { type: "uniqhash" });

      const setup = async () => {
        const driver = await createDriver();
        await execAsync(driver.loadTables([usersTable]));
        await execAsync(
          driver.insert(usersTable.tableName, [{ id: "a", email: "a@x" }]),
        );
        return driver;
      };

      const rejection = async (run: Promise<unknown>) => {
        try {
          await run;
        } catch (error) {
          return error;
        }
        throw new Error("expected the write to fail");
      };

      it("reports an existing id as DuplicateIdError", async () => {
        const driver = await setup();
        const error = await rejection(
          execAsync(
            driver.insert(usersTable.tableName, [
              { id: "b", email: "b@x" },
              { id: "a", email: "other@x" },
            ]),
          ),
        );

        expect(error).toBeInstanceOf(DuplicateIdError);
        expect((error as DuplicateIdError).id).toBe("a");
        expect((error as DuplicateIdError).cause).toBeInstanceOf(Error);
      });

      it("reports a repeated id inside one batch", async () => {
        const driver = await setup();
        const insertError = await rejection(
          execAsync(
            driver.insert(usersTable.tableName, [
              { id: "c", email: "c@x" },
              { id: "c", email: "c2@x" },
            ]),
          ),
        );
        const upsertError = await rejection(
          execAsync(
            driver.upsert(usersTable.tableName, [
              { id: "a", email: "a2@x" },
              { id: "a", email: "a3@x" },
            ]),
          ),
        );

        expect(insertError).toBeInstanceOf(DuplicateIdError);
        expect((insertError as DuplicateIdError).code).toBe("DUPLICATE_ID");
        expect((insertError as DuplicateIdError).id).toBe("c");
        expect(upsertError).toBeInstanceOf(DuplicateIdError);
        expect((upsertError as DuplicateIdError).code).toBe("DUPLICATE_ID");
        expect((upsertError as DuplicateIdError).id).toBe("a");
      });

      it("finds the duplicate when the batch spans several statements", async () => {
        const driver = await setup();
        const rows = Array.from({ length: 1000 }, (_, index) => ({
          id: `row-${index}`,
          email: `${index}@x`,
        }));
        const tx = await execAsync(driver.beginTx());
        const error = await rejection(
          execAsync(
            tx.insert(usersTable.tableName, [
              ...rows,
              { id: "row-3", email: "again@x" },
            ]),
          ),
        );
        // The failed write leaves nothing behind, even when committed.
        await execAsync(tx.commit());

        expect(error).toBeInstanceOf(DuplicateIdError);
        expect((error as DuplicateIdError).code).toBe("DUPLICATE_ID");
        expect((error as DuplicateIdError).id).toBe("row-3");
        expect(await execAsync(driver.scanAll!(usersTable.tableName))).toEqual([
          { id: "a", email: "a@x" },
        ]);
      });

      it("reports a row that repeats both its id and a unique value", async () => {
        const driver = await setup();
        const error = await rejection(
          execAsync(
            driver.insert(usersTable.tableName, [{ id: "a", email: "a@x" }]),
          ),
        );

        expect(error).toBeInstanceOf(DuplicateIdError);
        expect((error as DuplicateIdError).id).toBe("a");
      });

      it("keeps the engine error for unique-index violations", async () => {
        const driver = await setup();
        const error = await rejection(
          execAsync(
            driver.insert(usersTable.tableName, [{ id: "b", email: "a@x" }]),
          ),
        );

        expect(error).not.toBeInstanceOf(DuplicateIdError);
        expect(String((error as Error).message)).toContain(
          "UNIQUE constraint failed",
        );
      });
    });

    describe(`${name} transactions`, () => {
      it("rejects writes through a readonly transaction", async () => {
        const driver = await createDriver();
        await execAsync(driver.loadTables([noSideTablesTable]));
        await execAsync(
          driver.insert(noSideTablesTable.tableName, [{ id: "a", title: "A" }]),
        );
        const tx = await execAsync(driver.beginTx("readonly"));

        for (const run of [
          () => tx.insert(noSideTablesTable.tableName, [{ id: "b" }]),
          () => tx.upsert(noSideTablesTable.tableName, [{ id: "a" }]),
          () => tx.delete(noSideTablesTable.tableName, ["a"]),
        ]) {
          let error: unknown;
          try {
            await execAsync(run());
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(HyperDBError);
          expect((error as HyperDBError).code).toBe("READONLY_TRANSACTION");
        }
        expect(
          await execAsync(
            tx.intervalScan(noSideTablesTable.tableName, "byTitle", [{}], {}),
          ),
        ).toEqual([{ id: "a", title: "A" }]);
        await execAsync(tx.commit());
      });
    });
  }
});
