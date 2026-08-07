/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Row, SelectOptions, WhereClause } from "../../core/primitives";
import type { DBDriver, DBDriverTX } from "../../core/driver";
import type { TableDefinition } from "../../schema/table";
import type { DBCmd } from "../../commands/async";
import { unwrapCb } from "../../commands/async";
import { execAsync } from "../../core/executor";
import { cloneDeep } from "../../utils/toolkit";
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
  persistentPhysicalIndexes,
  SQLITE_SORT_KEY_SUFFIX,
  LEGACY_SQLITE_SORT_KEY_SUFFIX,
  assertSafeTableDefinition,
  buildRowInsertParams,
  parseSqliteStoredRow,
  type BindParams,
  type SqlValue,
} from "./sqlite-common";
import AwaitLock from "../../utils/await-lock";

export interface AsyncSQLStatement {
  values(values: SqlValue[]): Promise<SqlValue[][]>;
  finalize(): void | Promise<void>;
}
export interface AsyncSQLiteDB {
  exec(sql: string, params?: BindParams): Promise<void>;
  prepare(sql: string): AsyncSQLStatement | Promise<AsyncSQLStatement>;
}

export type AsyncSqlDriverDebugOperation =
  | "exec"
  | "insert"
  | "delete"
  | "scan";
export type AsyncSqlDriverDebugEvent = {
  operation: AsyncSqlDriverDebugOperation;
  status: "success" | "error";
  sql: string;
  normalizedSql: string;
  durationMs: number;
  tableName?: string;
  indexName?: string;
  rowCount?: number;
  paramCount?: number;
  params?: BindParams;
  truncatedParams?: number;
  error?: unknown;
};
export type AsyncSqlDriverDebug = (event: AsyncSqlDriverDebugEvent) => void;
export type AsyncSqlDriverOptions = {
  debug?: AsyncSqlDriverDebug;
};

export function formatAsyncSqlDriverDebugEvent(
  event: AsyncSqlDriverDebugEvent,
): string {
  const prefix = event.status === "error" ? "FAILED " : "";
  const rowCount =
    typeof event.rowCount === "number" ? ` | ${event.rowCount} rows` : "";

  return `${prefix}${event.normalizedSql} | ${event.durationMs}ms${rowCount}`;
}

export function logAsyncSqlDriverDebugEvent(
  event: AsyncSqlDriverDebugEvent,
): void {
  const message = `%c${formatAsyncSqlDriverDebugEvent(event)}`;

  if (event.status === "error") {
    console.error(message, "color: #facc15", event.error);
  } else {
    console.log(message, "color: #facc15");
  }
}

const SQL_PARAM_LOG_LIMIT = 40;

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function summarizeSqlParams(params?: BindParams) {
  if (!params) return undefined;

  return {
    paramCount: params.length,
    params:
      params.length <= SQL_PARAM_LOG_LIMIT
        ? params
        : params.slice(0, SQL_PARAM_LOG_LIMIT),
    truncatedParams:
      params.length > SQL_PARAM_LOG_LIMIT
        ? params.length - SQL_PARAM_LOG_LIMIT
        : 0,
  };
}

function emitAsyncSqlDebug(
  debug: AsyncSqlDriverDebug | undefined,
  operation: AsyncSqlDriverDebugOperation,
  sql: string,
  startedAt: number,
  details: () => Partial<AsyncSqlDriverDebugEvent> = () => ({}),
  error?: unknown,
): void {
  if (!debug) return;

  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  debug({
    operation,
    status: error ? "error" : "success",
    sql,
    normalizedSql,
    durationMs: Math.round(nowMs() - startedAt),
    ...details(),
    ...(error === undefined ? {} : { error }),
  });
}

async function runAsyncSQL(
  db: AsyncSQLiteDB,
  sql: string,
  params?: BindParams,
  debug?: AsyncSqlDriverDebug,
): Promise<void> {
  const startedAt = debug ? nowMs() : 0;
  try {
    await db.exec(sql, params);
    emitAsyncSqlDebug(debug, "exec", sql, startedAt, () => ({
      ...summarizeSqlParams(params),
    }));
  } catch (error) {
    emitAsyncSqlDebug(
      debug,
      "exec",
      sql,
      startedAt,
      () => ({
        ...summarizeSqlParams(params),
      }),
      error,
    );
    throw error;
  }
}

async function rollbackAsyncQuietly(
  db: AsyncSQLiteDB,
  reason?: unknown,
  debug?: AsyncSqlDriverDebug,
): Promise<void> {
  try {
    if (reason) {
      console.warn("Rolling back SQLite transaction after error", reason);
    } else {
      console.warn("Rolling back SQLite transaction");
    }
    await runAsyncSQL(db, "ROLLBACK", undefined, debug);
  } catch (rollbackError) {
    console.warn("Failed to rollback SQLite transaction", rollbackError);
    // Best effort cleanup after a failed statement.
  }
}

function* performAsyncInsertOperation(
  db: AsyncSQLiteDB,
  tableDef: TableDefinition,
  values: Row[],
  debug?: AsyncSqlDriverDebug,
): Generator<DBCmd, void> {
  if (values.length === 0) return;

  yield* unwrapCb(async () => {
    const allValues = chunkArray(values, getSqliteInsertChunkSize(tableDef));
    for (const chunk of allValues) {
      const insertSQL = buildInsertSQL(tableDef, chunk.length);
      const params = chunk.flatMap((v) => buildRowInsertParams(tableDef, v));
      const startedAt = debug ? nowMs() : 0;

      try {
        await db.exec(insertSQL, params);
        emitAsyncSqlDebug(debug, "insert", insertSQL, startedAt, () => ({
          tableName: tableDef.tableName,
          rowCount: chunk.length,
          ...summarizeSqlParams(params),
        }));
      } catch (error) {
        emitAsyncSqlDebug(
          debug,
          "insert",
          insertSQL,
          startedAt,
          () => ({
            tableName: tableDef.tableName,
            rowCount: chunk.length,
            ...summarizeSqlParams(params),
          }),
          error,
        );
        throw error;
      }
    }
  });
}

function* performAsyncUpsertOperation(
  db: AsyncSQLiteDB,
  tableDef: TableDefinition,
  values: Row[],
  debug?: AsyncSqlDriverDebug,
): Generator<DBCmd, void> {
  if (values.length === 0) return;

  yield* performAsyncDeleteOperation(
    db,
    tableDef,
    values.map((value) => value.id),
    debug,
  );
  yield* performAsyncInsertOperation(db, tableDef, values, debug);
}

function* performAsyncDeleteOperation(
  db: AsyncSQLiteDB,
  tableDef: TableDefinition,
  values: string[],
  debug?: AsyncSqlDriverDebug,
): Generator<DBCmd, void> {
  if (values.length === 0) return;

  yield* unwrapCb(async () => {
    const allValues = chunkArray(values, getSqliteDeleteChunkSize());
    for (const chunk of allValues) {
      const deleteSQL = buildDeleteSQL(tableDef.tableName, chunk.length);
      const startedAt = debug ? nowMs() : 0;

      try {
        await db.exec(deleteSQL, chunk);
        emitAsyncSqlDebug(debug, "delete", deleteSQL, startedAt, () => ({
          tableName: tableDef.tableName,
          rowCount: chunk.length,
          ...summarizeSqlParams(chunk),
        }));
      } catch (error) {
        emitAsyncSqlDebug(
          debug,
          "delete",
          deleteSQL,
          startedAt,
          () => ({
            tableName: tableDef.tableName,
            rowCount: chunk.length,
            ...summarizeSqlParams(chunk),
          }),
          error,
        );
        throw error;
      }
    }
  });
}

function* performAsyncScanOperation(
  db: AsyncSQLiteDB,
  tableDefinitions: Map<string, TableDefinition>,
  table: string,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions,
  debug?: AsyncSqlDriverDebug,
): Generator<DBCmd, unknown[]> {
  return yield* unwrapCb(async () => {
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

    const result: unknown[] = [];
    const startedAt = debug ? nowMs() : 0;
    const stmt = await db.prepare(sql);

    try {
      for (const row of await stmt.values(params)) {
        const record = parseSqliteStoredRow(row[0] as string);
        result.push(record);
      }
      emitAsyncSqlDebug(debug, "scan", sql, startedAt, () => ({
        tableName: table,
        indexName,
        rowCount: result.length,
        ...summarizeSqlParams(params),
      }));
    } catch (error) {
      emitAsyncSqlDebug(
        debug,
        "scan",
        sql,
        startedAt,
        () => ({
          tableName: table,
          indexName,
          rowCount: result.length,
          ...summarizeSqlParams(params),
        }),
        error,
      );
      throw new Error(`Scan failed for index ${indexName}: ${error}`);
    } finally {
      await stmt.finalize();
    }

    return result;
  });
}

class AsyncSqlDriverTx implements DBDriverTX {
  private db: AsyncSQLiteDB;
  private tableDefinitions: Map<string, TableDefinition>;
  private committed = false;
  private rolledback = false;
  private onFinish: () => void;
  private queryLock = new AwaitLock();
  private debug: AsyncSqlDriverDebug | undefined;

  constructor(
    db: AsyncSQLiteDB,
    tableDefinitions: Map<string, TableDefinition>,
    onFinish: () => void,
    debug: AsyncSqlDriverDebug | undefined,
  ) {
    this.db = db;
    this.tableDefinitions = tableDefinitions;
    this.onFinish = onFinish;
    this.debug = debug;
  }

  *commit(): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }

    yield* unwrapCb(async () => {
      await runAsyncSQL(this.db, "COMMIT", undefined, this.debug);
    });

    this.committed = true;
    this.onFinish();
  }

  *rollback(): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }

    yield* unwrapCb(async () => {
      await runAsyncSQL(this.db, "ROLLBACK", undefined, this.debug);
    });

    this.rolledback = true;
    this.onFinish();
  }

  *insert(
    tableName: string,
    values: Record<string, unknown>[],
  ): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.queryLock.acquireAsync();
    });

    try {
      if (this.committed || this.rolledback) {
        throw new Error("Transaction already finished");
      }
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      yield* performAsyncInsertOperation(
        this.db,
        tableDef,
        values as Row[],
        this.debug,
      );
    } finally {
      this.queryLock.release();
    }
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.queryLock.acquireAsync();
    });

    try {
      if (this.committed || this.rolledback) {
        throw new Error("Transaction already finished");
      }
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      yield* performAsyncUpsertOperation(this.db, tableDef, values, this.debug);
    } finally {
      this.queryLock.release();
    }
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.queryLock.acquireAsync();
    });

    try {
      if (this.committed || this.rolledback) {
        throw new Error("Transaction already finished");
      }
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      yield* performAsyncDeleteOperation(this.db, tableDef, values, this.debug);
    } finally {
      this.queryLock.release();
    }
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    yield* unwrapCb(async () => {
      await this.queryLock.acquireAsync();
    });

    try {
      if (this.committed || this.rolledback) {
        throw new Error("Transaction already finished");
      }

      return yield* performAsyncScanOperation(
        this.db,
        this.tableDefinitions,
        table,
        indexName,
        clauses,
        selectOptions,
        this.debug,
      );
    } finally {
      this.queryLock.release();
    }
  }
}

export class AsyncSqlDriver implements DBDriver {
  private db: AsyncSQLiteDB;
  private tableDefinitions = new Map<string, TableDefinition>();
  private txAndQueryLock = new AwaitLock();
  private debug: AsyncSqlDriverDebug | undefined;

  constructor(db: AsyncSQLiteDB, options: AsyncSqlDriverOptions = {}) {
    this.db = db;
    this.debug = options.debug;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    yield* unwrapCb(async () => {
      await runAsyncSQL(this.db, "BEGIN TRANSACTION", undefined, this.debug);
    });

    return new AsyncSqlDriverTx(
      this.db,
      this.tableDefinitions,
      () => {
        this.txAndQueryLock.release();
      },
      this.debug,
    );
  }

  *insert(
    tableName: string,
    values: Record<string, unknown>[],
  ): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    try {
      if (values.length === 0) return;

      let transactionStarted = false;
      try {
        yield* unwrapCb(async () => {
          await runAsyncSQL(
            this.db,
            "BEGIN TRANSACTION",
            undefined,
            this.debug,
          );
        });
        transactionStarted = true;

        yield* performAsyncInsertOperation(
          this.db,
          this.getTableDefinition(tableName),
          values as Row[],
          this.debug,
        );

        yield* unwrapCb(async () => {
          await runAsyncSQL(this.db, "COMMIT", undefined, this.debug);
        });
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          yield* unwrapCb(async () => {
            await rollbackAsyncQuietly(this.db, error, this.debug);
          });
        }
        throw error;
      }
    } finally {
      this.txAndQueryLock.release();
    }
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    try {
      if (values.length === 0) return;

      let transactionStarted = false;
      try {
        yield* unwrapCb(async () => {
          await runAsyncSQL(
            this.db,
            "BEGIN TRANSACTION",
            undefined,
            this.debug,
          );
        });
        transactionStarted = true;

        yield* performAsyncUpsertOperation(
          this.db,
          this.getTableDefinition(tableName),
          values,
          this.debug,
        );

        yield* unwrapCb(async () => {
          await runAsyncSQL(this.db, "COMMIT", undefined, this.debug);
        });
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          yield* unwrapCb(async () => {
            await rollbackAsyncQuietly(this.db, error, this.debug);
          });
        }
        throw error;
      }
    } finally {
      this.txAndQueryLock.release();
    }
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    try {
      if (values.length === 0) return;

      let transactionStarted = false;
      try {
        yield* unwrapCb(async () => {
          await runAsyncSQL(
            this.db,
            "BEGIN TRANSACTION",
            undefined,
            this.debug,
          );
        });
        transactionStarted = true;

        yield* performAsyncDeleteOperation(
          this.db,
          this.getTableDefinition(tableName),
          values,
          this.debug,
        );

        yield* unwrapCb(async () => {
          await runAsyncSQL(this.db, "COMMIT", undefined, this.debug);
        });
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          yield* unwrapCb(async () => {
            await rollbackAsyncQuietly(this.db, error, this.debug);
          });
        }
        throw error;
      }
    } finally {
      this.txAndQueryLock.release();
    }
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    try {
      return yield* performAsyncScanOperation(
        this.db,
        this.tableDefinitions,
        table,
        indexName,
        clauses,
        selectOptions,
        this.debug,
      );
    } finally {
      this.txAndQueryLock.release();
    }
  }

  *loadTables(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      await this.txAndQueryLock.acquireAsync();
    });

    try {
      for (const tableDef of tableDefinitions) {
        assertSafeTableDefinition(tableDef);
      }

      yield* unwrapCb(async () => {
        await runAsyncSQL(this.db, "BEGIN TRANSACTION", undefined, this.debug);

        tableDefinitions = cloneDeep(tableDefinitions);
        for (const tableDef of tableDefinitions) {
          await this.createTable(tableDef);
          const indexUniqueness = await this.getGeneratedIndexUniqueness(
            tableDef.tableName,
          );
          const reencodedColumns = this.reencodedSortKeyColumns(
            tableDef,
            indexUniqueness,
          );
          await this.dropStaleSortKeyIndexes(tableDef, indexUniqueness);
          await this.dropStaleSortKeyColumns(tableDef);
          await this.addMissingSortKeyColumns(tableDef);
          await this.resetSortKeyColumns(tableDef, reencodedColumns);
          await this.backfillSortKeyColumns(tableDef);
          await this.createIndexes(tableDef);
          this.tableDefinitions.set(tableDef.tableName, tableDef);
        }

        await runAsyncSQL(this.db, "COMMIT", undefined, this.debug);
      });
    } catch (error) {
      yield* unwrapCb(async () => {
        await rollbackAsyncQuietly(this.db, error, this.debug);
      });
      throw error;
    } finally {
      this.txAndQueryLock.release();
    }
  }

  private async createTable(tableDef: TableDefinition<any>): Promise<void> {
    const sql = createTableSQL(tableDef);
    await runAsyncSQL(this.db, sql, undefined, this.debug);
  }

  private async getTableColumns(tableName: string): Promise<Set<string>> {
    const columns = new Set<string>();
    const sql = `PRAGMA table_info(${tableName})`;
    const startedAt = this.debug ? nowMs() : 0;
    const stmt = await this.db.prepare(sql);

    try {
      for (const row of await stmt.values([])) {
        columns.add(String(row[1]));
      }
      emitAsyncSqlDebug(this.debug, "scan", sql, startedAt, () => ({
        tableName,
        rowCount: columns.size,
      }));
    } catch (error) {
      emitAsyncSqlDebug(
        this.debug,
        "scan",
        sql,
        startedAt,
        () => ({
          tableName,
          rowCount: columns.size,
        }),
        error,
      );
      throw error;
    } finally {
      await stmt.finalize();
    }

    return columns;
  }

  private async getGeneratedIndexUniqueness(
    tableName: string,
  ): Promise<Map<string, boolean>> {
    const indexes = new Map<string, boolean>();
    const sql = `PRAGMA index_list(${tableName})`;
    const startedAt = this.debug ? nowMs() : 0;
    const stmt = await this.db.prepare(sql);

    try {
      for (const row of await stmt.values([])) {
        indexes.set(String(row[1]), Number(row[2]) === 1);
      }
      emitAsyncSqlDebug(this.debug, "scan", sql, startedAt, () => ({
        tableName,
        rowCount: indexes.size,
      }));
    } catch (error) {
      emitAsyncSqlDebug(
        this.debug,
        "scan",
        sql,
        startedAt,
        () => ({
          tableName,
          rowCount: indexes.size,
        }),
        error,
      );
      throw error;
    } finally {
      await stmt.finalize();
    }

    return indexes;
  }

  private getExpectedSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Set<string> {
    return new Set(
      persistentPhysicalIndexes(tableDef).map((physicalIndex) =>
        sqliteIndexSortKeyColumn(physicalIndex.name),
      ),
    );
  }

  private getExpectedIndexNames(tableDef: TableDefinition<any>): Set<string> {
    return new Set(
      persistentPhysicalIndexes(tableDef).map((physicalIndex) =>
        sqliteIndexIdentifier(tableDef.tableName, physicalIndex.name),
      ),
    );
  }

  private isGeneratedIndexName(tableName: string, indexName: string): boolean {
    return (
      indexName.startsWith(`idx_${tableName}_`) &&
      (indexName.endsWith(SQLITE_SORT_KEY_SUFFIX) ||
        indexName.endsWith(LEGACY_SQLITE_SORT_KEY_SUFFIX))
    );
  }

  private async dropStaleSortKeyIndexes(
    tableDef: TableDefinition<any>,
    indexUniqueness: Map<string, boolean>,
  ): Promise<void> {
    const expectedIndexes = this.getExpectedIndexNames(tableDef);
    for (const [indexName, unique] of indexUniqueness) {
      if (!this.isGeneratedIndexName(tableDef.tableName, indexName)) continue;
      if (expectedIndexes.has(indexName)) {
        const tableIndexName = this.tableIndexNameFromGenerated(
          tableDef.tableName,
          indexName,
        );
        const expectedUnique =
          persistentPhysicalIndexes(tableDef).find(
            (physicalIndex) => physicalIndex.name === tableIndexName,
          )?.unique ?? false;
        if (unique === expectedUnique) continue;
      }

      await runAsyncSQL(
        this.db,
        dropIndexSQL(indexName),
        undefined,
        this.debug,
      );
    }
  }

  private tableIndexNameFromGenerated(
    tableName: string,
    generatedIndexName: string,
  ): string {
    const indexName = generatedIndexName.slice(`idx_${tableName}_`.length);
    const suffix = indexName.endsWith(SQLITE_SORT_KEY_SUFFIX)
      ? SQLITE_SORT_KEY_SUFFIX
      : LEGACY_SQLITE_SORT_KEY_SUFFIX;
    return indexName.slice(0, -suffix.length);
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
      const tableIndexName = this.tableIndexNameFromGenerated(
        tableDef.tableName,
        indexName,
      );
      const physicalIndex = persistentPhysicalIndexes(tableDef).find(
        (candidate) => candidate.name === tableIndexName,
      );
      if (!physicalIndex) continue;
      const expectedUnique = physicalIndex.unique;
      if (unique !== expectedUnique) {
        columns.push(sqliteIndexSortKeyColumn(tableIndexName));
      }
    }
    return columns;
  }

  private async resetSortKeyColumns(
    tableDef: TableDefinition<any>,
    sortKeyColumns: string[],
  ): Promise<void> {
    const existingColumns = await this.getTableColumns(tableDef.tableName);
    for (const sortKeyColumn of sortKeyColumns) {
      if (!existingColumns.has(sortKeyColumn)) continue;
      await runAsyncSQL(
        this.db,
        `UPDATE ${tableDef.tableName} SET ${sortKeyColumn} = NULL`,
        undefined,
        this.debug,
      );
    }
  }

  private async dropStaleSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Promise<void> {
    const expectedColumns = this.getExpectedSortKeyColumns(tableDef);
    for (const columnName of await this.getTableColumns(tableDef.tableName)) {
      if (!isSqliteSortKeyColumn(columnName)) continue;
      if (expectedColumns.has(columnName)) continue;

      await runAsyncSQL(
        this.db,
        dropSortKeyColumnSQL(tableDef.tableName, columnName),
        undefined,
        this.debug,
      );
    }
  }

  private async addMissingSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Promise<void> {
    const existingColumns = await this.getTableColumns(tableDef.tableName);
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      if (existingColumns.has(sortKeyColumn)) continue;

      const sql = addSortKeyColumnSQL(tableDef.tableName, sortKeyColumn);
      await runAsyncSQL(this.db, sql, undefined, this.debug);
      existingColumns.add(sortKeyColumn);
    }
  }

  // NOTE: backwards compatibility. Remove after v1.
  private async backfillSortKeyColumns(
    tableDef: TableDefinition<any>,
  ): Promise<void> {
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      const sql = `SELECT data FROM ${tableDef.tableName} WHERE ${sortKeyColumn} IS NULL`;
      const startedAt = this.debug ? nowMs() : 0;
      const stmt = await this.db.prepare(sql);

      try {
        const rows = await stmt.values([]);
        emitAsyncSqlDebug(this.debug, "scan", sql, startedAt, () => ({
          tableName: tableDef.tableName,
          indexName: physicalIndex.name,
          rowCount: rows.length,
        }));
        for (const chunk of chunkArray(rows, CHUNK_SIZE)) {
          await execAsync(
            performAsyncUpsertOperation(
              this.db,
              tableDef,
              chunk.map(([data]) => parseSqliteStoredRow(String(data))),
              this.debug,
            ),
          );
        }
      } catch (error) {
        emitAsyncSqlDebug(
          this.debug,
          "scan",
          sql,
          startedAt,
          () => ({
            tableName: tableDef.tableName,
            indexName: physicalIndex.name,
          }),
          error,
        );
        throw error;
      } finally {
        await stmt.finalize();
      }
    }
  }

  private async createIndexes(tableDef: TableDefinition<any>): Promise<void> {
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const indexSQL = createIndexSQL(tableDef, physicalIndex.name);
      await runAsyncSQL(this.db, indexSQL, undefined, this.debug);
    }
  }

  private getTableDefinition(tableName: string): TableDefinition {
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    return tableDef;
  }
}
