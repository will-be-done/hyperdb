/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Row, SelectOptions, WhereClause } from "../../core/primitives";
import type { DBDriver, DBDriverTX } from "../../core/driver";
import type { TableDefinition } from "../../schema/table";
import type { DBCmd } from "../../commands/async";
import { cloneDeep } from "../../utils/toolkit";
import { getPersistentIndexPlan } from "../persistent-index-plan";
import {
  buildSortKeyWhereClause,
  buildOrderClause,
  buildSelectSQL,
  buildInsertSQL,
  buildDeleteSQL,
  createTableSQL,
  createIndexSQL,
  dropIndexSQL,
  addSortKeyColumnSQL,
  dropSortKeyColumnSQL,
  chunkArray,
  CHUNK_SIZE,
  getSqliteDeleteChunkSize,
  getSqliteInsertChunkSize,
  sqliteIndexSortKeyColumn,
  sqliteIndexIdentifier,
  isSqliteSortKeyColumn,
  SQLITE_SORT_KEY_SUFFIX,
  LEGACY_SQLITE_SORT_KEY_SUFFIX,
  createSqliteTableSchemaSignature,
  createSqliteSchemaMetadataTableSQL,
  selectSqliteSchemaMetadataSQL,
  selectSqliteSchemaMetadataTableExistsSQL,
  upsertSqliteSchemaMetadataSQL,
  sqliteSchemaMetadataMatches,
  sqliteWriteNeedsSavepoint,
  SQLITE_WRITE_SAVEPOINT,
  toSqliteSchemaMetadataReadError,
  sqliteIdentifierKey,
  assertSafeTableDefinition,
  buildRowInsertParams,
  parseSqliteStoredRow,
  type SqlValue,
} from "./sqlite-common";
import { HyperDBError, isHyperDBError } from "../../core/errors";
import { err, ok, type Result } from "../../utils/result";

// The SQLite driver logic lives here once, written as DBCmd generators. The
// sync and async drivers differ only in how a statement runs (a plain call vs.
// an awaited one, see SqliteConnection) and how they serialize access (see
// SqliteLock). A sync connection never yields, so execSync can drive it.

export type SqliteOperation = "exec" | "insert" | "delete" | "scan";

/** What a statement is for. Async drivers report it to the debug hook. */
export type SqliteStatementInfo = {
  operation: SqliteOperation;
  tableName?: string;
  indexName?: string;
  rowCount?: number;
};

export interface SqliteConnection {
  exec(
    sql: string,
    params?: SqlValue[],
    info?: SqliteStatementInfo,
  ): Generator<DBCmd, void>;
  /** Prepares, reads every row, and finalizes the statement. */
  query(
    sql: string,
    params?: SqlValue[],
    info?: SqliteStatementInfo,
  ): Generator<DBCmd, SqlValue[][]>;
}

export interface SqliteLock {
  acquire(): Generator<DBCmd, void>;
  release(): void;
}

export type SqliteDriverRuntime = {
  connection: SqliteConnection;
  /** Held by a driver-level operation, or by a transaction until it ends. */
  driverLock: SqliteLock;
  /** Serializes the operations of one transaction. */
  createTxLock(): SqliteLock;
};

type WriteKind = "insert" | "upsert" | "delete";

function transactionFinished(): HyperDBError {
  return new HyperDBError(
    "TRANSACTION_FINISHED",
    "Transaction already finished",
  );
}

function getTableDefinition(
  tableDefinitions: Map<string, TableDefinition>,
  tableName: string,
): TableDefinition {
  const tableDef = tableDefinitions.get(tableName);
  if (!tableDef)
    throw new HyperDBError("TABLE_NOT_FOUND", `Table ${tableName} not found`);
  return tableDef;
}

function* insertRows(
  conn: SqliteConnection,
  tableDef: TableDefinition,
  values: Row[],
): Generator<DBCmd, void> {
  for (const chunk of chunkArray(values, getSqliteInsertChunkSize(tableDef))) {
    yield* conn.exec(
      buildInsertSQL(tableDef, chunk.length),
      chunk.flatMap((value) => buildRowInsertParams(tableDef, value)),
      {
        operation: "insert",
        tableName: tableDef.tableName,
        rowCount: chunk.length,
      },
    );
  }
}

function* deleteRows(
  conn: SqliteConnection,
  tableDef: TableDefinition,
  ids: string[],
): Generator<DBCmd, void> {
  for (const chunk of chunkArray(ids, getSqliteDeleteChunkSize())) {
    yield* conn.exec(buildDeleteSQL(tableDef.tableName, chunk.length), chunk, {
      operation: "delete",
      tableName: tableDef.tableName,
      rowCount: chunk.length,
    });
  }
}

function* upsertRows(
  conn: SqliteConnection,
  tableDef: TableDefinition,
  values: Row[],
): Generator<DBCmd, void> {
  if (values.length === 0) return;
  yield* deleteRows(
    conn,
    tableDef,
    values.map((value) => value.id),
  );
  yield* insertRows(conn, tableDef, values);
}

function writeRows(
  conn: SqliteConnection,
  kind: WriteKind,
  tableDef: TableDefinition,
  values: Row[] | string[],
): Generator<DBCmd, void> {
  switch (kind) {
    case "insert":
      return insertRows(conn, tableDef, values as Row[]);
    case "upsert":
      return upsertRows(conn, tableDef, values as Row[]);
    case "delete":
      return deleteRows(conn, tableDef, values as string[]);
  }
}

function* scanRows(
  conn: SqliteConnection,
  tableDefinitions: Map<string, TableDefinition>,
  table: string,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions,
): Generator<DBCmd, unknown[]> {
  getTableDefinition(tableDefinitions, table);
  const { where, params } = buildSortKeyWhereClause(
    indexName,
    table,
    clauses,
    tableDefinitions,
  );
  const orderClause = buildOrderClause(
    indexName,
    table,
    tableDefinitions,
    selectOptions.order === "desc",
  );
  const sql = buildSelectSQL(table, where, orderClause, selectOptions);

  let rows: SqlValue[][];
  try {
    rows = yield* conn.query(sql, params, {
      operation: "scan",
      tableName: table,
      indexName,
    });
  } catch (error) {
    // Coded errors (such as ASYNC_IN_SYNC_EXECUTION) keep their identity.
    if (isHyperDBError(error)) throw error;
    throw new Error(`Scan failed for index ${indexName}: ${error}`, {
      cause: error,
    });
  }
  return rows.map((row) => parseSqliteStoredRow(row[0] as string));
}

function* rollbackQuietly(conn: SqliteConnection): Generator<DBCmd, void> {
  try {
    yield* conn.exec("ROLLBACK");
  } catch (rollbackError) {
    // Best effort cleanup after a failed statement; the caller rethrows the
    // original error.
    console.warn("Failed to rollback SQLite transaction", rollbackError);
  }
}

// If the savepoint cannot be rolled back or released, part of the write may
// still be applied, so `poison` marks the transaction as unable to commit.
function* inWriteSavepoint(
  conn: SqliteConnection,
  run: () => Generator<DBCmd, void>,
  poison: (error: unknown) => void,
): Generator<DBCmd, void> {
  yield* conn.exec(`SAVEPOINT ${SQLITE_WRITE_SAVEPOINT}`);
  try {
    yield* run();
  } catch (error) {
    try {
      yield* conn.exec(`ROLLBACK TO ${SQLITE_WRITE_SAVEPOINT}`);
      yield* conn.exec(`RELEASE ${SQLITE_WRITE_SAVEPOINT}`);
    } catch {
      poison(error);
    }
    throw error;
  }
  try {
    yield* conn.exec(`RELEASE ${SQLITE_WRITE_SAVEPOINT}`);
  } catch (error) {
    poison(error);
    throw error;
  }
}

class SqliteDriverTx implements DBDriverTX {
  private conn: SqliteConnection;
  private tableDefinitions: Map<string, TableDefinition>;
  private lock: SqliteLock;
  private onFinish: () => void;
  private finished = false;
  // Set when a write's savepoint could not be cleaned up; commit refuses.
  private poisonedBy: { error: unknown } | undefined;
  private readonly poison = (error: unknown) => {
    this.poisonedBy ??= { error };
  };

  constructor(
    conn: SqliteConnection,
    tableDefinitions: Map<string, TableDefinition>,
    lock: SqliteLock,
    onFinish: () => void,
  ) {
    this.conn = conn;
    this.tableDefinitions = tableDefinitions;
    this.lock = lock;
    this.onFinish = onFinish;
  }

  *commit(): Generator<DBCmd, void> {
    if (this.finished) throw transactionFinished();
    if (this.poisonedBy) throw this.poisonedBy.error;
    yield* this.conn.exec("COMMIT");
    this.finish();
  }

  *rollback(): Generator<DBCmd, void> {
    if (this.finished) throw transactionFinished();
    yield* this.conn.exec("ROLLBACK");
    this.finish();
  }

  insert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    return this.write("insert", tableName, values);
  }

  upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    return this.write("upsert", tableName, values);
  }

  delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    return this.write("delete", tableName, values);
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    yield* this.lock.acquire();
    try {
      if (this.finished) throw transactionFinished();
      return yield* scanRows(
        this.conn,
        this.tableDefinitions,
        table,
        indexName,
        clauses,
        selectOptions,
      );
    } finally {
      this.lock.release();
    }
  }

  private finish(): void {
    this.finished = true;
    this.onFinish();
  }

  private *write(
    kind: WriteKind,
    tableName: string,
    values: Row[] | string[],
  ): Generator<DBCmd, void> {
    yield* this.lock.acquire();
    try {
      if (this.finished) throw transactionFinished();
      const tableDef = getTableDefinition(this.tableDefinitions, tableName);
      const run = () => writeRows(this.conn, kind, tableDef, values);
      if (sqliteWriteNeedsSavepoint(kind, tableDef, values.length)) {
        yield* inWriteSavepoint(this.conn, run, this.poison);
      } else {
        yield* run();
      }
    } finally {
      this.lock.release();
    }
  }
}

/** Shared implementation behind `SqlDriver` and `AsyncSqlDriver`. */
export class SqliteDriverCore implements DBDriver {
  private conn: SqliteConnection;
  private lock: SqliteLock;
  private createTxLock: () => SqliteLock;
  private tableDefinitions = new Map<string, TableDefinition>();

  constructor(runtime: SqliteDriverRuntime) {
    this.conn = runtime.connection;
    this.lock = runtime.driverLock;
    this.createTxLock = () => runtime.createTxLock();
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    yield* this.lock.acquire();
    try {
      yield* this.conn.exec("BEGIN TRANSACTION");
    } catch (error) {
      this.lock.release();
      throw error;
    }

    return new SqliteDriverTx(
      this.conn,
      this.tableDefinitions,
      this.createTxLock(),
      () => this.lock.release(),
    );
  }

  insert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    return this.write("insert", tableName, values);
  }

  upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    return this.write("upsert", tableName, values);
  }

  delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    return this.write("delete", tableName, values);
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    yield* this.lock.acquire();
    try {
      return yield* scanRows(
        this.conn,
        this.tableDefinitions,
        table,
        indexName,
        clauses,
        selectOptions,
      );
    } finally {
      this.lock.release();
    }
  }

  *scanAll(tableName: string): Generator<DBCmd, Row[]> {
    yield* this.lock.acquire();
    try {
      getTableDefinition(this.tableDefinitions, tableName);
      const rows = yield* this.conn.query(`SELECT data FROM ${tableName}`, [], {
        operation: "scan",
        tableName,
      });
      return rows.map((row) => parseSqliteStoredRow(row[0] as string));
    } finally {
      this.lock.release();
    }
  }

  *loadTables(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, void> {
    for (const tableDef of tableDefinitions) {
      assertSafeTableDefinition(tableDef);
    }

    tableDefinitions = cloneDeep(tableDefinitions);
    if (tableDefinitions.length === 0) return;

    yield* this.lock.acquire();
    try {
      if (!(yield* this.schemaMetadataMatches(tableDefinitions))) {
        yield* this.inTransaction(() => this.reconcileSchema(tableDefinitions));
      }
      for (const tableDef of tableDefinitions) {
        this.tableDefinitions.set(tableDef.tableName, tableDef);
      }
    } finally {
      this.lock.release();
    }
  }

  private *write(
    kind: WriteKind,
    tableName: string,
    values: Row[] | string[],
  ): Generator<DBCmd, void> {
    yield* this.lock.acquire();
    try {
      if (values.length === 0) return;
      yield* this.inTransaction(() =>
        writeRows(
          this.conn,
          kind,
          getTableDefinition(this.tableDefinitions, tableName),
          values,
        ),
      );
    } finally {
      this.lock.release();
    }
  }

  private *inTransaction(
    run: () => Generator<DBCmd, void>,
  ): Generator<DBCmd, void> {
    yield* this.conn.exec("BEGIN TRANSACTION");
    try {
      yield* run();
      yield* this.conn.exec("COMMIT");
    } catch (error) {
      yield* rollbackQuietly(this.conn);
      throw error;
    }
  }

  private *reconcileSchema(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, void> {
    yield* this.conn.exec(createSqliteSchemaMetadataTableSQL());
    for (const tableDef of tableDefinitions) {
      yield* this.conn.exec(createTableSQL(tableDef));
      const indexUniqueness = yield* this.getGeneratedIndexUniqueness(
        tableDef.tableName,
      );
      const reencodedColumns = this.reencodedSortKeyColumns(
        tableDef,
        indexUniqueness,
      );
      const existingColumns = yield* this.getTableColumns(tableDef.tableName);
      yield* this.dropStaleSortKeyIndexes(tableDef, indexUniqueness);
      yield* this.dropStaleSortKeyColumns(tableDef, existingColumns);
      yield* this.addMissingSortKeyColumns(tableDef, existingColumns);
      yield* this.resetSortKeyColumns(
        tableDef,
        reencodedColumns,
        existingColumns,
      );
      yield* this.backfillSortKeyColumns(tableDef);
      yield* this.createIndexes(tableDef);
    }
    yield* this.writeSchemaMetadata(tableDefinitions);
  }

  private *schemaMetadataMatches(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, boolean> {
    const read = yield* attempt(
      this.conn.query(
        selectSqliteSchemaMetadataSQL(tableDefinitions.length),
        tableDefinitions.map((tableDef) => tableDef.tableName),
        { operation: "scan" },
      ),
    );
    if (read.isOk()) {
      return sqliteSchemaMetadataMatches(tableDefinitions, read.value);
    }

    // A metadata table that does not exist yet means the schema must be
    // reconciled. Any other read failure is rethrown.
    const error = toSqliteSchemaMetadataReadError(read.error);
    if (error.kind === "missing") return false;
    // Preserve the original metadata-read error when even the fallback
    // schema inspection cannot run.
    const exists = (yield* attempt(this.schemaMetadataTableExists())).unwrapOr(
      true,
    );
    if (exists) throw error.cause;
    return false;
  }

  private *schemaMetadataTableExists(): Generator<DBCmd, boolean> {
    const rows = yield* this.conn.query(
      selectSqliteSchemaMetadataTableExistsSQL(),
      [],
      { operation: "scan" },
    );
    return rows.length > 0;
  }

  private *writeSchemaMetadata(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, void> {
    const rows = yield* this.conn.query(
      "SELECT schema_version FROM pragma_schema_version",
      [],
      { operation: "scan" },
    );
    const schemaVersion = Number(rows[0]?.[0]);
    if (!Number.isInteger(schemaVersion)) {
      throw new Error("SQLite did not return a valid schema version");
    }

    yield* this.conn.exec(
      upsertSqliteSchemaMetadataSQL(tableDefinitions.length),
      tableDefinitions.flatMap((tableDef) => [
        tableDef.tableName,
        createSqliteTableSchemaSignature(tableDef),
        schemaVersion,
      ]),
    );
  }

  private *getTableColumns(
    tableName: string,
  ): Generator<DBCmd, Map<string, string>> {
    const rows = yield* this.conn.query(`PRAGMA table_info(${tableName})`, [], {
      operation: "scan",
      tableName,
    });
    return new Map(
      rows.map((row) => {
        const columnName = String(row[1]);
        return [sqliteIdentifierKey(columnName), columnName];
      }),
    );
  }

  private *getGeneratedIndexUniqueness(
    tableName: string,
  ): Generator<DBCmd, Map<string, boolean>> {
    const rows = yield* this.conn.query(`PRAGMA index_list(${tableName})`, [], {
      operation: "scan",
      tableName,
    });
    return new Map(rows.map((row) => [String(row[1]), Number(row[2]) === 1]));
  }

  private getExpectedSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Set<string> {
    return new Set(
      getPersistentIndexPlan(tableDef).physicalIndexes.map((physicalIndex) =>
        sqliteIdentifierKey(sqliteIndexSortKeyColumn(physicalIndex.name)),
      ),
    );
  }

  private getExpectedIndexNames(tableDef: TableDefinition<any>): Set<string> {
    return new Set(
      getPersistentIndexPlan(tableDef).physicalIndexes.map((physicalIndex) =>
        sqliteIdentifierKey(
          sqliteIndexIdentifier(tableDef.tableName, physicalIndex.name),
        ),
      ),
    );
  }

  private isGeneratedIndexName(tableName: string, indexName: string): boolean {
    const normalizedIndexName = sqliteIdentifierKey(indexName);
    return (
      normalizedIndexName.startsWith(
        sqliteIdentifierKey(`idx_${tableName}_`),
      ) &&
      (normalizedIndexName.endsWith(SQLITE_SORT_KEY_SUFFIX) ||
        normalizedIndexName.endsWith(LEGACY_SQLITE_SORT_KEY_SUFFIX))
    );
  }

  private physicalIndexForGeneratedIdentifier(
    tableDef: TableDefinition<any>,
    generatedIndexName: string,
  ) {
    const normalizedGeneratedIndexName =
      sqliteIdentifierKey(generatedIndexName);
    return getPersistentIndexPlan(tableDef).physicalIndexes.find(
      (physicalIndex) =>
        sqliteIdentifierKey(
          sqliteIndexIdentifier(tableDef.tableName, physicalIndex.name),
        ) === normalizedGeneratedIndexName,
    );
  }

  private *dropStaleSortKeyIndexes(
    tableDef: TableDefinition<any>,
    indexUniqueness: Map<string, boolean>,
  ): Generator<DBCmd, void> {
    const expectedIndexes = this.getExpectedIndexNames(tableDef);
    for (const [indexName, unique] of indexUniqueness) {
      if (!this.isGeneratedIndexName(tableDef.tableName, indexName)) continue;
      if (expectedIndexes.has(sqliteIdentifierKey(indexName))) {
        const expectedUnique =
          this.physicalIndexForGeneratedIdentifier(tableDef, indexName)
            ?.unique ?? false;
        if (unique === expectedUnique) continue;
      }

      yield* this.conn.exec(dropIndexSQL(indexName));
    }
  }

  // Sort-key columns whose encoding changed because the index flipped between
  // uniqhash (value only) and hash/btree (value + id). Their existing values
  // are encoded with the old shape, so they must be recomputed for every row
  // rather than left to the NULL-only backfill.
  private reencodedSortKeyColumns(
    tableDef: TableDefinition<any>,
    indexUniqueness: Map<string, boolean>,
  ): string[] {
    const columns: string[] = [];
    for (const [indexName, unique] of indexUniqueness) {
      if (!this.isGeneratedIndexName(tableDef.tableName, indexName)) continue;
      const physicalIndex = this.physicalIndexForGeneratedIdentifier(
        tableDef,
        indexName,
      );
      if (!physicalIndex) continue;
      if (unique !== physicalIndex.unique) {
        columns.push(sqliteIndexSortKeyColumn(physicalIndex.name));
      }
    }
    return columns;
  }

  private *resetSortKeyColumns(
    tableDef: TableDefinition<any>,
    sortKeyColumns: string[],
    existingColumns: Map<string, string>,
  ): Generator<DBCmd, void> {
    for (const sortKeyColumn of sortKeyColumns) {
      if (!existingColumns.has(sqliteIdentifierKey(sortKeyColumn))) continue;
      yield* this.conn.exec(
        `UPDATE ${tableDef.tableName} SET ${sortKeyColumn} = NULL`,
      );
    }
  }

  private *dropStaleSortKeyColumns(
    tableDef: TableDefinition<any>,
    existingColumns: Map<string, string>,
  ): Generator<DBCmd, void> {
    const expectedColumns = this.getExpectedSortKeyColumns(tableDef);
    for (const [normalizedColumnName, columnName] of existingColumns) {
      if (!isSqliteSortKeyColumn(columnName)) continue;
      if (expectedColumns.has(normalizedColumnName)) continue;

      yield* this.conn.exec(
        dropSortKeyColumnSQL(tableDef.tableName, columnName),
      );
      existingColumns.delete(normalizedColumnName);
    }
  }

  private *addMissingSortKeyColumns(
    tableDef: TableDefinition<any>,
    existingColumns: Map<string, string>,
  ): Generator<DBCmd, void> {
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      const normalizedSortKeyColumn = sqliteIdentifierKey(sortKeyColumn);
      if (existingColumns.has(normalizedSortKeyColumn)) continue;

      yield* this.conn.exec(
        addSortKeyColumnSQL(tableDef.tableName, sortKeyColumn),
      );
      existingColumns.set(normalizedSortKeyColumn, sortKeyColumn);
    }
  }

  // NOTE: backwards compatibility. Remove after v1.
  private *backfillSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Generator<DBCmd, void> {
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      const rows = yield* this.conn.query(
        `SELECT data FROM ${tableDef.tableName} WHERE ${sortKeyColumn} IS NULL`,
        [],
        {
          operation: "scan",
          tableName: tableDef.tableName,
          indexName: physicalIndex.name,
        },
      );

      for (const chunk of chunkArray(rows, CHUNK_SIZE)) {
        yield* upsertRows(
          this.conn,
          tableDef,
          chunk.map(([data]) => parseSqliteStoredRow(String(data))),
        );
      }
    }
  }

  private *createIndexes(
    tableDef: TableDefinition<any>,
  ): Generator<DBCmd, void> {
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
      yield* this.conn.exec(createIndexSQL(tableDef, physicalIndex.name));
    }
  }
}

function* attempt<T>(
  run: Generator<DBCmd, T>,
): Generator<DBCmd, Result<T, unknown>> {
  try {
    return ok(yield* run);
  } catch (error) {
    return err(error);
  }
}
