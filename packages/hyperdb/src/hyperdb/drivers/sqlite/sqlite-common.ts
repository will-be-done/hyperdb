/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  MAX,
  MIN,
  type Row,
  type WhereClause,
  type SelectOptions,
} from "../../core/primitives";
import type { TableDefinition } from "../../schema/table";
import { convertWhereToBound } from "../../core/query/bounds";
import {
  decodeValueFromStorage,
  encodeValueForStorage,
} from "../../storage/codec";
import {
  encodeSqliteSortKeyTuple,
  getSqliteSortKeyTuple,
  type SqliteSortKeyMode,
} from "./sqlite-sort-key";

export type SqlValue = number | string | Uint8Array | null;
export type BindParams = SqlValue[] | null;

type SqliteRowCompressionBase = {
  compress(data: string): Uint8Array;
  decompress(data: Uint8Array): string;
};

export type SqliteRowCompression = SqliteRowCompressionBase &
  (
    | {
        compressAsync?: never;
        decompressAsync?: never;
      }
    | {
        compressAsync(data: string): Promise<Uint8Array>;
        decompressAsync(data: Uint8Array): Promise<string>;
      }
  );

export const CHUNK_SIZE = 12000;
export const SQL_BIND_PARAM_LIMIT = 900;

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SQLITE_SORT_KEY_SUFFIX = "_sort_key_v2";
export const LEGACY_SQLITE_SORT_KEY_SUFFIX = "_sort_key";

export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function getSqliteInsertChunkSize(tableDef: TableDefinition): number {
  const columnCount = 2 + persistentPhysicalIndexes(tableDef).length;
  return Math.max(1, Math.floor(SQL_BIND_PARAM_LIMIT / columnCount));
}

export function getSqliteDeleteChunkSize(): number {
  return SQL_BIND_PARAM_LIMIT;
}

function isSchemalessTable(tableDef: TableDefinition): boolean {
  return !tableDef.schemaValidator;
}

export type PersistentPhysicalIndex = {
  name: string;
  logicalNames: string[];
  cols: string[];
  sortColumns: string[];
  type: "hash" | "uniqhash" | "btree";
  unique: boolean;
  mode: SqliteSortKeyMode;
};

const persistentPhysicalIndexCache = new WeakMap<
  TableDefinition,
  PersistentPhysicalIndex[]
>();

export function isPrimaryKeyBackedIndex(
  tableDef: TableDefinition,
  indexName: string,
): boolean {
  const indexDef = tableDef.indexes[indexName];
  return (
    indexDef !== undefined &&
    (indexDef.type === "hash" || indexDef.type === "uniqhash") &&
    indexDef.cols.length === 1 &&
    String(indexDef.cols[0]) === "id"
  );
}

export function persistentPhysicalIndexes(
  tableDef: TableDefinition,
): PersistentPhysicalIndex[] {
  const cached = persistentPhysicalIndexCache.get(tableDef);
  if (cached) return cached;

  const logicalNames = Object.keys(tableDef.indexes)
    .filter((indexName) => !isPrimaryKeyBackedIndex(tableDef, indexName))
    .sort();
  const consumed = new Set<string>();
  const physicalIndexes: PersistentPhysicalIndex[] = [];

  for (const logicalName of logicalNames) {
    if (consumed.has(logicalName)) continue;
    const indexDef = tableDef.indexes[logicalName]!;
    const cols = indexDef.cols.map(String);
    const mode = sqliteIndexSortKeyMode(tableDef, logicalName);
    const aliases = [logicalName];

    if (indexDef.type === "btree" || indexDef.type === "uniqhash") {
      for (const candidateName of logicalNames) {
        if (candidateName === logicalName || consumed.has(candidateName)) {
          continue;
        }
        const candidate = tableDef.indexes[candidateName]!;
        const candidateColumns = candidate.cols.map(String);
        const isUniqueOrderedPair =
          new Set([indexDef.type, candidate.type]).size === 2 &&
          (indexDef.type === "uniqhash" || candidate.type === "uniqhash") &&
          (indexDef.type === "btree" || candidate.type === "btree");
        const sameColumns =
          cols.length === candidateColumns.length &&
          cols.every((column, index) => column === candidateColumns[index]);

        if (
          isUniqueOrderedPair &&
          sameColumns &&
          mode === sqliteIndexSortKeyMode(tableDef, candidateName)
        ) {
          aliases.push(candidateName);
        }
      }
    }

    aliases.sort();
    for (const alias of aliases) consumed.add(alias);
    const unique = aliases.some(
      (alias) => tableDef.indexes[alias]?.type === "uniqhash",
    );
    const physicalType = unique ? "uniqhash" : indexDef.type;
    const sortColumns = [...cols];
    if (!unique && sortColumns[sortColumns.length - 1] !== "id") {
      sortColumns.push("id");
    }

    physicalIndexes.push({
      name: aliases[0]!,
      logicalNames: aliases,
      cols,
      sortColumns,
      type: physicalType,
      unique,
      mode,
    });
  }

  persistentPhysicalIndexCache.set(tableDef, physicalIndexes);
  return physicalIndexes;
}

export function persistentPhysicalIndexForLogicalName(
  tableDef: TableDefinition,
  indexName: string,
): PersistentPhysicalIndex | undefined {
  return persistentPhysicalIndexes(tableDef).find((physicalIndex) =>
    physicalIndex.logicalNames.includes(indexName),
  );
}

export function assertSafeIdentifier(kind: string, value: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${kind} must be a safe SQL/JSON identifier: ${value}`);
  }
}

export function assertSafeTableDefinition(tableDef: TableDefinition): void {
  assertSafeIdentifier("Table name", tableDef.tableName);

  for (const indexName of Object.keys(tableDef.indexes)) {
    assertSafeIdentifier("Index name", indexName);
  }
}

export function sqliteIndexSortKeyColumn(indexName: string): string {
  assertSafeIdentifier("Index name", indexName);
  const columnName = `idx_${indexName}${SQLITE_SORT_KEY_SUFFIX}`;
  assertSafeIdentifier("Sort-key column name", columnName);
  return columnName;
}

export function sqliteIndexIdentifier(
  tableName: string,
  indexName: string,
): string {
  assertSafeIdentifier("Table name", tableName);
  assertSafeIdentifier("Index name", indexName);
  const indexIdentifier = `idx_${tableName}_${indexName}${SQLITE_SORT_KEY_SUFFIX}`;
  assertSafeIdentifier("SQLite index name", indexIdentifier);
  return indexIdentifier;
}

export function isSqliteSortKeyColumn(columnName: string): boolean {
  return (
    columnName.startsWith("idx_") &&
    (columnName.endsWith(SQLITE_SORT_KEY_SUFFIX) ||
      columnName.endsWith(LEGACY_SQLITE_SORT_KEY_SUFFIX))
  );
}

export function sqliteIndexSortColumns(
  tableDef: TableDefinition,
  indexName: string,
): string[] {
  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) throw new Error(`Index ${indexName} not found`);

  const physicalIndex = persistentPhysicalIndexForLogicalName(
    tableDef,
    indexName,
  );
  return physicalIndex?.sortColumns ?? indexDef.cols.map(String);
}

export function sqliteIndexSortKeyMode(
  tableDef: TableDefinition,
  indexName: string,
): SqliteSortKeyMode {
  const indexDef = tableDef.indexes[indexName];
  return indexDef?.type === "btree" && isSchemalessTable(tableDef)
    ? "stored"
    : "scan";
}

export function getSqliteIndexSortKeyValue(
  tableDef: TableDefinition,
  indexName: string,
  row: Row,
): Uint8Array | null {
  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) throw new Error(`Index ${indexName} not found`);

  const physicalIndex = persistentPhysicalIndexForLogicalName(
    tableDef,
    indexName,
  );
  if (!physicalIndex) {
    throw new Error(`Index ${indexName} uses the primary-key access path`);
  }
  const sortColumns = physicalIndex.sortColumns;
  const includeMissing =
    indexDef.type === "btree" && isSchemalessTable(tableDef);
  const mode = physicalIndex.mode;
  const tuple = getSqliteSortKeyTuple(row, sortColumns, includeMissing);

  return tuple ? encodeSqliteSortKeyTuple(tuple, mode) : null;
}

export function buildRowInsertParams(
  tableDef: TableDefinition,
  row: Row,
  rowCompression?: SqliteRowCompression,
): SqlValue[] {
  const storageRow = encodeValueForStorage(row) as Row;
  const json = JSON.stringify(storageRow);

  return [
    storageRow.id,
    rowCompression ? rowCompression.compress(json) : json,
    ...persistentPhysicalIndexes(tableDef).map((physicalIndex) =>
      getSqliteIndexSortKeyValue(tableDef, physicalIndex.name, storageRow),
    ),
  ];
}

export async function buildRowInsertParamsAsync(
  tableDef: TableDefinition,
  row: Row,
  rowCompression: SqliteRowCompression,
): Promise<SqlValue[]> {
  const storageRow = encodeValueForStorage(row) as Row;
  const json = JSON.stringify(storageRow);
  const data = rowCompression.compressAsync
    ? await rowCompression.compressAsync(json)
    : rowCompression.compress(json);

  return [
    storageRow.id,
    data,
    ...persistentPhysicalIndexes(tableDef).map((physicalIndex) =>
      getSqliteIndexSortKeyValue(tableDef, physicalIndex.name, storageRow),
    ),
  ];
}

function compressedStoredRowJson(
  data: SqlValue,
  rowCompression?: SqliteRowCompression,
): string {
  if (typeof data === "string") return data;
  if (!(data instanceof Uint8Array)) {
    throw new Error(`SQLite row data must be TEXT or BLOB, got ${typeof data}`);
  }
  if (!rowCompression) {
    throw new Error(
      "SQLite row data is compressed, but no rowCompression codec is configured",
    );
  }
  return rowCompression.decompress(data);
}

export function parseSqliteStoredRow(
  data: SqlValue,
  rowCompression?: SqliteRowCompression,
): Row {
  return decodeValueFromStorage(
    JSON.parse(compressedStoredRowJson(data, rowCompression)),
  ) as Row;
}

export async function parseSqliteStoredRowAsync(
  data: SqlValue,
  rowCompression: SqliteRowCompression,
): Promise<Row> {
  if (typeof data === "string") {
    return decodeValueFromStorage(JSON.parse(data)) as Row;
  }
  if (!(data instanceof Uint8Array)) {
    throw new Error(`SQLite row data must be TEXT or BLOB, got ${typeof data}`);
  }
  const json = rowCompression.decompressAsync
    ? await rowCompression.decompressAsync(data)
    : rowCompression.decompress(data);
  return decodeValueFromStorage(JSON.parse(json)) as Row;
}

export function hasAsyncRowCompression(
  rowCompression: SqliteRowCompression | undefined,
): rowCompression is SqliteRowCompression &
  Required<Pick<SqliteRowCompression, "compressAsync" | "decompressAsync">> {
  return (
    rowCompression?.compressAsync !== undefined &&
    rowCompression.decompressAsync !== undefined
  );
}

export function assertValidRowCompression(
  rowCompression: SqliteRowCompression | undefined,
): void {
  if (!rowCompression) return;
  const hasCompressAsync = rowCompression.compressAsync !== undefined;
  const hasDecompressAsync = rowCompression.decompressAsync !== undefined;
  if (hasCompressAsync !== hasDecompressAsync) {
    throw new Error(
      "rowCompression.compressAsync and decompressAsync must be provided together",
    );
  }
}

function expandBoundTuple(
  tuple: readonly unknown[] | undefined,
  targetLength: number,
  filler: typeof MIN | typeof MAX,
): unknown[] | undefined {
  if (!tuple) return undefined;
  return [...tuple, ...new Array(targetLength - tuple.length).fill(filler)];
}

function validateHashBounds(
  indexName: string,
  indexColumns: string[],
  bounds: ReturnType<typeof convertWhereToBound>,
): void {
  const indexColumn = indexColumns.join(", ");

  for (const bound of bounds) {
    if (
      (bound.gt !== undefined && bound.gt.length > 0) ||
      (bound.lt !== undefined && bound.lt.length > 0)
    ) {
      throw new Error(
        `Hash index doesn't support range conditions for column '${indexColumn}'`,
      );
    }

    if (
      !bound.lte ||
      !bound.gte ||
      bound.lte.length !== indexColumns.length ||
      bound.gte.length !== indexColumns.length
    ) {
      throw new Error(
        `Hash index should have equality conditions for columns '${indexColumn}' and index name '${indexName}': ${JSON.stringify(bound)}`,
      );
    }

    if (
      bound.lte.some((value, index) => !Object.is(value, bound.gte?.[index]))
    ) {
      throw new Error(
        `Hash index should have the same equality condition for columns '${indexColumn}' and index name '${indexName}'`,
      );
    }
  }
}

function isExactSortKeyBound(bound: {
  gte?: unknown[];
  gt?: unknown[];
  lte?: unknown[];
  lt?: unknown[];
}): bound is {
  gte: unknown[];
  lte: unknown[];
  gt?: undefined;
  lt?: undefined;
} {
  const { gte, lte } = bound;

  return (
    gte !== undefined &&
    lte !== undefined &&
    bound.gt === undefined &&
    bound.lt === undefined &&
    gte.length === lte.length &&
    gte.every((value, index) => Object.is(value, lte[index]))
  );
}

function joinBalancedOr(expressions: readonly string[]): string {
  if (expressions.length === 0) {
    throw new Error("Cannot join an empty list of SQL expressions");
  }
  if (expressions.length === 1) return expressions[0]!;

  const middle = Math.ceil(expressions.length / 2);
  return `(${joinBalancedOr(expressions.slice(0, middle))} OR ${joinBalancedOr(
    expressions.slice(middle),
  )})`;
}

export function buildSortKeyWhereClause(
  indexName: string,
  tableName: string,
  clauses: WhereClause[],
  tableDefinitions: Map<string, TableDefinition>,
): { where: string; params: any[] } {
  const tableDef = tableDefinitions.get(tableName);
  if (!tableDef) {
    throw new Error(`Table ${tableName} not found`);
  }

  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) throw new Error(`Index ${indexName} not found`);
  const filterColumns = indexDef.cols.map(String);
  const rawBounds = convertWhereToBound(filterColumns, clauses);

  if (indexDef.type === "hash" || indexDef.type === "uniqhash") {
    validateHashBounds(indexName, filterColumns, rawBounds);
  }

  if (isPrimaryKeyBackedIndex(tableDef, indexName)) {
    const ids = rawBounds.map((bound) => bound.gte?.[0]);
    if (ids.some((id) => typeof id !== "string")) {
      throw new Error(`Primary-key index ${indexName} requires string IDs`);
    }
    const placeholders = ids.map(() => "?").join(", ");
    return {
      where: `WHERE id IN (${placeholders})`,
      params: ids,
    };
  }

  const physicalIndex = persistentPhysicalIndexForLogicalName(
    tableDef,
    indexName,
  );
  if (!physicalIndex) throw new Error(`Physical index ${indexName} not found`);
  const sortColumns = physicalIndex.sortColumns;
  const mode = physicalIndex.mode;

  const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
  const params: any[] = [];
  const rangeConditions: string[] = [];
  const exactSortKeys: Uint8Array[] = [];
  let hasUnboundedRange = false;

  for (const rawBound of rawBounds) {
    const bound = {
      gte: expandBoundTuple(rawBound.gte, sortColumns.length, MIN),
      gt: expandBoundTuple(rawBound.gt, sortColumns.length, MAX),
      lte: expandBoundTuple(rawBound.lte, sortColumns.length, MAX),
      lt: expandBoundTuple(rawBound.lt, sortColumns.length, MIN),
    };

    if (isExactSortKeyBound(bound)) {
      exactSortKeys.push(encodeSqliteSortKeyTuple(bound.gte, mode));
      continue;
    }

    const current: string[] = [];
    const currentParams: Uint8Array[] = [];

    if (bound.gte) {
      current.push(`${sortKeyColumn} >= ?`);
      currentParams.push(encodeSqliteSortKeyTuple(bound.gte, mode));
    }
    if (bound.gt) {
      current.push(`${sortKeyColumn} > ?`);
      currentParams.push(encodeSqliteSortKeyTuple(bound.gt, mode));
    }
    if (bound.lte) {
      current.push(`${sortKeyColumn} <= ?`);
      currentParams.push(encodeSqliteSortKeyTuple(bound.lte, mode));
    }
    if (bound.lt) {
      current.push(`${sortKeyColumn} < ?`);
      currentParams.push(encodeSqliteSortKeyTuple(bound.lt, mode));
    }

    if (current.length === 0) {
      hasUnboundedRange = true;
      break;
    }

    rangeConditions.push(`(${current.join(" AND ")})`);
    params.push(...currentParams);
  }

  const conditions = [`${sortKeyColumn} IS NOT NULL`];
  if (hasUnboundedRange) {
    params.length = 0;
  } else if (rangeConditions.length > 0) {
    params.unshift(...exactSortKeys);
    if (exactSortKeys.length > 0) {
      const placeholders = exactSortKeys.map(() => "?").join(", ");
      conditions.push(
        `(${sortKeyColumn} IN (${placeholders}) OR ${joinBalancedOr(
          rangeConditions,
        )})`,
      );
    } else {
      conditions.push(joinBalancedOr(rangeConditions));
    }
  } else if (exactSortKeys.length > 0) {
    const placeholders = exactSortKeys.map(() => "?").join(", ");
    conditions.push(`${sortKeyColumn} IN (${placeholders})`);
    params.push(...exactSortKeys);
  }

  return {
    where: `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

export function buildOrderClause(
  indexName: string,
  tableName: string,
  tableDefinitions: Map<string, TableDefinition>,
  reverse: boolean = false,
): string {
  const tableDef = tableDefinitions.get(tableName);
  if (!tableDef) {
    return "";
  }

  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) {
    return "";
  }

  if (isPrimaryKeyBackedIndex(tableDef, indexName)) {
    return "";
  }
  const physicalIndex = persistentPhysicalIndexForLogicalName(
    tableDef,
    indexName,
  );
  if (!physicalIndex) return "";

  return `ORDER BY ${sqliteIndexSortKeyColumn(physicalIndex.name)} ${
    reverse ? "DESC" : "ASC"
  }`;
}

export function buildInsertSQL(
  tableDef: TableDefinition,
  valueCount: number,
): string {
  const indexColumns = persistentPhysicalIndexes(tableDef).map(
    (physicalIndex) => sqliteIndexSortKeyColumn(physicalIndex.name),
  );
  const columns = ["id", "data", ...indexColumns];
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const valuesQ = Array(valueCount).fill(rowPlaceholders).join(", ");
  const sql = `INSERT INTO ${tableDef.tableName} (${columns.join(
    ", ",
  )}) VALUES ${valuesQ}`
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function buildDeleteSQL(tableName: string, idCount: number): string {
  const placeholders = Array(idCount).fill("?").join(", ");
  const sql = `DELETE FROM ${tableName} WHERE id IN (${placeholders})`
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function buildSelectSQL(
  tableName: string,
  whereClause: string,
  orderClause: string,
  selectOptions: SelectOptions,
): string {
  const limitClause =
    selectOptions.limit !== undefined ? `LIMIT ${selectOptions.limit}` : "";

  const sql = `
    SELECT data
    FROM ${tableName}
    ${whereClause}
    ${orderClause}
    ${limitClause}
  `
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function createTableSQL(
  tableDef: TableDefinition,
  compressedRows = false,
): string {
  const sortKeyColumns = persistentPhysicalIndexes(tableDef).map(
    (physicalIndex) => `${sqliteIndexSortKeyColumn(physicalIndex.name)} BLOB`,
  );
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableDef.tableName} (
      id TEXT PRIMARY KEY,
      data ${compressedRows ? "BLOB" : "TEXT"} NOT NULL
      ${sortKeyColumns.length > 0 ? `, ${sortKeyColumns.join(", ")}` : ""}
    )
  `
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function createIndexSQL(
  tableDef: TableDefinition,
  indexName: string,
): string {
  const tableName = tableDef.tableName;
  const physicalIndex = persistentPhysicalIndexForLogicalName(
    tableDef,
    indexName,
  );
  if (!physicalIndex) throw new Error(`Physical index ${indexName} not found`);

  const sortKeyColumn = sqliteIndexSortKeyColumn(physicalIndex.name);
  const indexIdentifier = sqliteIndexIdentifier(tableName, physicalIndex.name);
  const unique = physicalIndex.unique ? "UNIQUE " : "";
  const indexColumns = physicalIndex.unique
    ? sortKeyColumn
    : `${sortKeyColumn}, id`;
  const sql = `
    CREATE ${unique}INDEX IF NOT EXISTS ${indexIdentifier}
    ON ${tableName}(${indexColumns})
    WHERE ${sortKeyColumn} IS NOT NULL
  `
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function dropIndexSQL(indexIdentifier: string): string {
  assertSafeIdentifier("SQLite index name", indexIdentifier);
  return `DROP INDEX IF EXISTS ${indexIdentifier}`;
}

export function addSortKeyColumnSQL(
  tableName: string,
  sortKeyColumn: string,
): string {
  assertSafeIdentifier("Sort-key column name", sortKeyColumn);
  const sql = `ALTER TABLE ${tableName} ADD COLUMN ${sortKeyColumn} BLOB`
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}

export function dropSortKeyColumnSQL(
  tableName: string,
  sortKeyColumn: string,
): string {
  assertSafeIdentifier("Table name", tableName);
  assertSafeIdentifier("Sort-key column name", sortKeyColumn);
  const sql = `ALTER TABLE ${tableName} DROP COLUMN ${sortKeyColumn}`
    .trim()
    .replace(/\n+/g, " ");

  return sql;
}
