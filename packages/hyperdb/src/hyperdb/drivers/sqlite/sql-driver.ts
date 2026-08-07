/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Row, SelectOptions, WhereClause } from "../../core/primitives";
import type { DBDriver, DBDriverTX } from "../../core/driver";
import type { TableDefinition } from "../../schema/table";
import type { DBCmd } from "../../commands/async";
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
  type SqlValue,
  type BindParams,
} from "./sqlite-common";

export interface SQLStatement {
  values(values: SqlValue[]): SqlValue[][];
  // all(params?: BindParams): QueryExecResult[];
  // bind(values?: BindParams): boolean;
  // get(params?: BindParams): SqlValue[];
  // step(): boolean;
  finalize(): void;
}
export interface SQLiteDB {
  exec(sql: string, params?: BindParams): void;
  prepare(sql: string): SQLStatement;
}

function performInsertOperation(
  db: SQLiteDB,
  tableDef: TableDefinition,
  values: Row[],
): void {
  if (values.length === 0) return;

  const allValues = chunkArray(values, getSqliteInsertChunkSize(tableDef));
  for (const chunk of allValues) {
    const insertSQL = buildInsertSQL(tableDef, chunk.length);

    db.exec(
      insertSQL,
      chunk.flatMap((v) => buildRowInsertParams(tableDef, v)),
    );
  }
}

function performUpsertOperation(
  db: SQLiteDB,
  tableDef: TableDefinition,
  values: Row[],
): void {
  if (values.length === 0) return;

  performDeleteOperation(
    db,
    tableDef,
    values.map((value) => value.id),
  );
  performInsertOperation(db, tableDef, values);
}

function performDeleteOperation(
  db: SQLiteDB,
  tableDef: TableDefinition,
  values: string[],
): void {
  if (values.length === 0) return;

  const allValues = chunkArray(values, getSqliteDeleteChunkSize());
  for (const chunk of allValues) {
    const deleteSQL = buildDeleteSQL(tableDef.tableName, chunk.length);
    db.exec(deleteSQL, chunk);
  }
}

function performScanOperation(
  db: SQLiteDB,
  tableDefinitions: Map<string, TableDefinition>,
  table: string,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions,
): unknown[] {
  const tableDef = tableDefinitions.get(table);
  if (!tableDef) {
    throw new Error(`Table ${table} not found`);
  }

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
  const q = db.prepare(sql);

  try {
    const values = q.values(params);
    return values.map((row) => parseSqliteStoredRow(row[0] as string));

    // while (q.step()) {
    //   const res = q.get();
    //   const record = parseSqliteStoredRow(res[0] as string);
    //   result.push(record);
    // }
  } catch (error) {
    throw new Error(`Scan failed for index ${indexName}: ${error}`);
  } finally {
    q.finalize();
  }
}

function rollbackQuietly(db: SQLiteDB): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Best effort cleanup after a failed statement.
  }
}

class SqlDriverTx implements DBDriverTX {
  private db: SQLiteDB;
  private tableDefinitions: Map<string, TableDefinition>;
  private committed = false;
  private rolledback = false;
  private onFinish: () => void;

  constructor(
    db: SQLiteDB,
    tableDefinitions: Map<string, TableDefinition>,
    onFinish: () => void,
  ) {
    this.db = db;
    this.tableDefinitions = tableDefinitions;
    this.db.exec("BEGIN TRANSACTION");
    this.onFinish = onFinish;
  }

  *commit(): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
    this.db.exec("COMMIT");
    this.committed = true;
    this.onFinish();
  }

  *rollback(): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
    this.db.exec("ROLLBACK");
    this.rolledback = true;
    this.onFinish();
  }

  *insert(
    tableName: string,
    values: Record<string, unknown>[],
  ): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    performInsertOperation(this.db, tableDef, values as Row[]);
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    performUpsertOperation(this.db, tableDef, values);
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    performDeleteOperation(this.db, tableDef, values);
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }

    return performScanOperation(
      this.db,
      this.tableDefinitions,
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }
}

export class SqlDriver implements DBDriver {
  private db: SQLiteDB;
  private tableDefinitions = new Map<string, TableDefinition>();
  private isInTransaction = false;

  constructor(db: SQLiteDB) {
    this.db = db;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    if (this.isInTransaction) {
      throw new Error("can't run while transaction is in progress");
    }

    this.isInTransaction = true;
    return new SqlDriverTx(
      this.db,
      this.tableDefinitions,
      () => (this.isInTransaction = false),
    );
  }

  *insert(
    tableName: string,
    values: Record<string, unknown>[],
  ): Generator<DBCmd, void> {
    if (this.isInTransaction) {
      throw new Error("can't run while transaction is in progress");
    }
    if (values.length === 0) return;

    this.db.exec("BEGIN TRANSACTION");
    try {
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      performInsertOperation(this.db, tableDef, values as Row[]);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (this.isInTransaction) {
      throw new Error("can't run while transaction is in progress");
    }
    if (values.length === 0) return;

    this.db.exec("BEGIN TRANSACTION");
    try {
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      performUpsertOperation(this.db, tableDef, values);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    if (this.isInTransaction) {
      throw new Error("can't run while transaction is in progress");
    }
    if (values.length === 0) return;

    this.db.exec("BEGIN TRANSACTION");
    try {
      const tableDef = this.tableDefinitions.get(tableName);
      if (!tableDef) throw new Error(`Table ${tableName} not found`);
      performDeleteOperation(this.db, tableDef, values);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    if (this.isInTransaction) {
      throw new Error("can't run while transaction is in progress");
    }

    return performScanOperation(
      this.db,
      this.tableDefinitions,
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }

  *loadTables(
    tableDefinitions: TableDefinition<any>[],
  ): Generator<DBCmd, void> {
    for (const tableDef of tableDefinitions) {
      assertSafeTableDefinition(tableDef);
    }

    this.db.exec("BEGIN TRANSACTION");
    try {
      tableDefinitions = cloneDeep(tableDefinitions);
      for (const tableDef of tableDefinitions) {
        this.createTable(tableDef);
        const indexUniqueness = this.getGeneratedIndexUniqueness(
          tableDef.tableName,
        );
        const reencodedColumns = this.reencodedSortKeyColumns(
          tableDef,
          indexUniqueness,
        );
        this.dropStaleSortKeyIndexes(tableDef, indexUniqueness);
        this.dropStaleSortKeyColumns(tableDef);
        this.addMissingSortKeyColumns(tableDef);
        this.resetSortKeyColumns(tableDef, reencodedColumns);
        this.backfillSortKeyColumns(tableDef);
        this.createIndexes(tableDef);
        this.tableDefinitions.set(tableDef.tableName, tableDef);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  private createTable(tableDef: TableDefinition<any>): void {
    const sql = createTableSQL(tableDef);
    this.db.exec(sql);
  }

  private getTableColumns(tableName: string): Set<string> {
    const q = this.db.prepare(`PRAGMA table_info(${tableName})`);
    try {
      return new Set(q.values([]).map((row) => String(row[1])));
    } finally {
      q.finalize();
    }
  }

  private getGeneratedIndexUniqueness(tableName: string): Map<string, boolean> {
    const q = this.db.prepare(`PRAGMA index_list(${tableName})`);
    try {
      return new Map(
        q.values([]).map((row) => [String(row[1]), Number(row[2]) === 1]),
      );
    } finally {
      q.finalize();
    }
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

  private dropStaleSortKeyIndexes(
    tableDef: TableDefinition<any>,
    indexUniqueness: Map<string, boolean>,
  ): void {
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

      this.db.exec(dropIndexSQL(indexName));
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

  private resetSortKeyColumns(
    tableDef: TableDefinition<any>,
    sortKeyColumns: string[],
  ): void {
    const existingColumns = this.getTableColumns(tableDef.tableName);
    for (const sortKeyColumn of sortKeyColumns) {
      if (!existingColumns.has(sortKeyColumn)) continue;
      this.db.exec(`UPDATE ${tableDef.tableName} SET ${sortKeyColumn} = NULL`);
    }
  }

  private dropStaleSortKeyColumns(tableDef: TableDefinition<any>): void {
    const expectedColumns = this.getExpectedSortKeyColumns(tableDef);
    for (const columnName of this.getTableColumns(tableDef.tableName)) {
      if (!isSqliteSortKeyColumn(columnName)) continue;
      if (expectedColumns.has(columnName)) continue;

      this.db.exec(dropSortKeyColumnSQL(tableDef.tableName, columnName));
    }
  }

  private addMissingSortKeyColumns(tableDef: TableDefinition<any>): void {
    const existingColumns = this.getTableColumns(tableDef.tableName);
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      if (existingColumns.has(sortKeyColumn)) continue;

      const sql = addSortKeyColumnSQL(tableDef.tableName, sortKeyColumn);
      this.db.exec(sql);
      existingColumns.add(sortKeyColumn);
    }
  }

  // NOTE: backwards compatibility. Remove after v1.
  private backfillSortKeyColumns(tableDef: TableDefinition<any>): void {
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      const q = this.db.prepare(
        `SELECT data FROM ${tableDef.tableName} WHERE ${sortKeyColumn} IS NULL`,
      );

      try {
        for (const chunk of chunkArray(q.values([]), CHUNK_SIZE)) {
          performUpsertOperation(
            this.db,
            tableDef,
            chunk.map(([data]) => parseSqliteStoredRow(String(data))),
          );
        }
      } finally {
        q.finalize();
      }
    }
  }

  private createIndexes(tableDef: TableDefinition<any>): void {
    for (const physicalIndex of persistentPhysicalIndexes(tableDef)) {
      const indexSQL = createIndexSQL(tableDef, physicalIndex.name);
      this.db.exec(indexSQL);
    }
  }
}
