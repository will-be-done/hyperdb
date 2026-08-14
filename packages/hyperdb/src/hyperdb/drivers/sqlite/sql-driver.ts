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
  isMissingSqliteSchemaMetadataError,
  sqliteIdentifierKey,
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

    tableDefinitions = cloneDeep(tableDefinitions);
    if (tableDefinitions.length === 0) return;

    if (this.schemaMetadataMatches(tableDefinitions)) {
      this.installTableDefinitions(tableDefinitions);
      return;
    }

    this.db.exec("BEGIN TRANSACTION");
    try {
      this.db.exec(createSqliteSchemaMetadataTableSQL());
      for (const tableDef of tableDefinitions) {
        this.createTable(tableDef);
        const indexUniqueness = this.getGeneratedIndexUniqueness(
          tableDef.tableName,
        );
        const reencodedColumns = this.reencodedSortKeyColumns(
          tableDef,
          indexUniqueness,
        );
        const existingColumns = this.getTableColumns(tableDef.tableName);
        this.dropStaleSortKeyIndexes(tableDef, indexUniqueness);
        this.dropStaleSortKeyColumns(tableDef, existingColumns);
        this.addMissingSortKeyColumns(tableDef, existingColumns);
        this.resetSortKeyColumns(tableDef, reencodedColumns, existingColumns);
        this.backfillSortKeyColumns(tableDef);
        this.createIndexes(tableDef);
      }
      this.writeSchemaMetadata(tableDefinitions);
      this.db.exec("COMMIT");
      this.installTableDefinitions(tableDefinitions);
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
  }

  private schemaMetadataMatches(
    tableDefinitions: TableDefinition<any>[],
  ): boolean {
    const sql = selectSqliteSchemaMetadataSQL(tableDefinitions.length);
    let statement: SQLStatement | undefined;

    try {
      statement = this.db.prepare(sql);
      const rows = statement.values(
        tableDefinitions.map((tableDef) => tableDef.tableName),
      );
      const schemaVersion = Number(rows[0]?.[3]);
      if (!Number.isInteger(schemaVersion)) return false;

      const metadataByTable = new Map(
        rows
          .filter((row) => typeof row[0] === "string")
          .map((row) => [
            String(row[0]),
            {
              signature: String(row[1]),
              verifiedSchemaVersion: Number(row[2]),
            },
          ]),
      );

      return tableDefinitions.every((tableDef) => {
        const metadata = metadataByTable.get(tableDef.tableName);
        return (
          metadata?.signature === createSqliteTableSchemaSignature(tableDef) &&
          metadata.verifiedSchemaVersion === schemaVersion
        );
      });
    } catch (error) {
      if (isMissingSqliteSchemaMetadataError(error)) return false;
      statement?.finalize();
      statement = undefined;
      try {
        if (!this.schemaMetadataTableExists()) return false;
      } catch {
        // Preserve the original metadata-read error when even the fallback
        // schema inspection cannot run.
      }
      throw error;
    } finally {
      statement?.finalize();
    }
  }

  private schemaMetadataTableExists(): boolean {
    const statement = this.db.prepare(
      selectSqliteSchemaMetadataTableExistsSQL(),
    );
    try {
      return statement.values([]).length > 0;
    } finally {
      statement.finalize();
    }
  }

  private getSchemaVersion(): number {
    const statement = this.db.prepare(
      "SELECT schema_version FROM pragma_schema_version",
    );
    try {
      const schemaVersion = Number(statement.values([])[0]?.[0]);
      if (!Number.isInteger(schemaVersion)) {
        throw new Error("SQLite did not return a valid schema version");
      }
      return schemaVersion;
    } finally {
      statement.finalize();
    }
  }

  private writeSchemaMetadata(tableDefinitions: TableDefinition<any>[]): void {
    const schemaVersion = this.getSchemaVersion();
    this.db.exec(
      upsertSqliteSchemaMetadataSQL(tableDefinitions.length),
      tableDefinitions.flatMap((tableDef) => [
        tableDef.tableName,
        createSqliteTableSchemaSignature(tableDef),
        schemaVersion,
      ]),
    );
  }

  private installTableDefinitions(
    tableDefinitions: TableDefinition<any>[],
  ): void {
    for (const tableDef of tableDefinitions) {
      this.tableDefinitions.set(tableDef.tableName, tableDef);
    }
  }

  private createTable(tableDef: TableDefinition<any>): void {
    const sql = createTableSQL(tableDef);
    this.db.exec(sql);
  }

  private getTableColumns(tableName: string): Map<string, string> {
    const q = this.db.prepare(`PRAGMA table_info(${tableName})`);
    try {
      return new Map(
        q.values([]).map((row) => {
          const columnName = String(row[1]);
          return [sqliteIdentifierKey(columnName), columnName];
        }),
      );
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

  private dropStaleSortKeyIndexes(
    tableDef: TableDefinition<any>,
    indexUniqueness: Map<string, boolean>,
  ): void {
    const expectedIndexes = this.getExpectedIndexNames(tableDef);
    for (const [indexName, unique] of indexUniqueness) {
      if (!this.isGeneratedIndexName(tableDef.tableName, indexName)) continue;
      if (expectedIndexes.has(sqliteIdentifierKey(indexName))) {
        const expectedUnique =
          this.physicalIndexForGeneratedIdentifier(tableDef, indexName)
            ?.unique ?? false;
        if (unique === expectedUnique) continue;
      }

      this.db.exec(dropIndexSQL(indexName));
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
      const expectedUnique = physicalIndex.unique;
      if (unique !== expectedUnique) {
        columns.push(sqliteIndexSortKeyColumn(physicalIndex.name));
      }
    }
    return columns;
  }

  private resetSortKeyColumns(
    tableDef: TableDefinition<any>,
    sortKeyColumns: string[],
    existingColumns: Map<string, string>,
  ): void {
    for (const sortKeyColumn of sortKeyColumns) {
      if (!existingColumns.has(sqliteIdentifierKey(sortKeyColumn))) continue;
      this.db.exec(`UPDATE ${tableDef.tableName} SET ${sortKeyColumn} = NULL`);
    }
  }

  private dropStaleSortKeyColumns(
    tableDef: TableDefinition<any>,
    existingColumns: Map<string, string>,
  ): void {
    const expectedColumns = this.getExpectedSortKeyColumns(tableDef);
    for (const [normalizedColumnName, columnName] of existingColumns) {
      if (!isSqliteSortKeyColumn(columnName)) continue;
      if (expectedColumns.has(normalizedColumnName)) continue;

      this.db.exec(dropSortKeyColumnSQL(tableDef.tableName, columnName));
      existingColumns.delete(normalizedColumnName);
    }
  }

  private addMissingSortKeyColumns(
    tableDef: TableDefinition<any>,
    existingColumns: Map<string, string>,
  ): void {
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
      const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
      const normalizedSortKeyColumn = sqliteIdentifierKey(sortKeyColumn);
      if (existingColumns.has(normalizedSortKeyColumn)) continue;

      const sql = addSortKeyColumnSQL(tableDef.tableName, sortKeyColumn);
      this.db.exec(sql);
      existingColumns.set(normalizedSortKeyColumn, sortKeyColumn);
    }
  }

  // NOTE: backwards compatibility. Remove after v1.
  private backfillSortKeyColumns(tableDef: TableDefinition<any>): void {
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
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
    for (const physicalIndex of getPersistentIndexPlan(tableDef)
      .physicalIndexes) {
      const indexSQL = createIndexSQL(tableDef, physicalIndex.name);
      this.db.exec(indexSQL);
    }
  }
}
