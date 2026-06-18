/* eslint-disable @typescript-eslint/no-explicit-any */
import { unwrapCb, type DBCmd } from "../../commands/async";
import type { DBDriver, DBDriverTX } from "../../core/driver";
import {
  MAX,
  MIN,
  type Row,
  type SelectOptions,
  type WhereClause,
} from "../../core/primitives";
import { convertWhereToBound } from "../../core/query/bounds";
import type { TableDefinition } from "../../schema/table";
import { decodeValueFromStorage } from "../../storage/codec";
import {
  assertSafeTableDefinition,
  getSqliteIndexSortKeyValue,
  sqliteIndexSortColumns,
  sqliteIndexSortKeyMode,
} from "../sqlite/sqlite-common";
import { encodeSqliteSortKeyTuple } from "../sqlite/sqlite-sort-key";

type NativeStoredRecord = {
  id: string;
  row: unknown;
  indexes: Record<string, string>;
};

type StoredTableMetadata = {
  tableName: string;
  indexSignature: string;
};

type StoreMode = "readonly" | "readwrite";
type LockRelease = () => void;

export type OpenIndexedDBDriverOptions = {
  indexedDB?: IDBFactory;
  version?: number;
  durability?: IDBTransactionDurability;
  onBlocked?: (event: IDBVersionChangeEvent) => void;
  onVersionChange?: (event: IDBVersionChangeEvent) => void;
};

const OLD_ROWS_STORE = "rows";
const OLD_INDEX_ENTRIES_STORE = "indexEntries";
const TABLE_METADATA_STORE = "tableMetadata";
const TABLE_STORE_PREFIX = "hyperdb:";
const TABLE_INDEX_SIGNATURE_VERSION = 4;
const IDB_READ_BATCH_SIZE = 1000;
const STALE_CONNECTION_MESSAGE =
  "IndexedDB connection is stale; reopen the driver";

type IdbRecord<T> = {
  key: IDBValidKey;
  primaryKey: IDBValidKey;
  value: T;
};

type GetAllRecordsSource<T> = {
  getAllRecords?: (options?: {
    query?: IDBValidKey | IDBKeyRange | null;
    count?: number;
    direction?: IDBCursorDirection;
  }) => IDBRequest<IdbRecord<T>[]>;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function formatIdbLogDetail(details: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof details.tableName === "string") {
    parts.push(`table ${details.tableName}`);
  }
  if (typeof details.indexName === "string") {
    parts.push(`using index ${details.indexName}`);
  }
  if (typeof details.mode === "string") {
    parts.push(`mode ${details.mode}`);
  }
  if (typeof details.rowCount === "number") {
    parts.push(`${details.rowCount} rows`);
  }

  return parts.length === 0 ? "" : ` | ${parts.join(" | ")}`;
}

function logIdbOperation(
  operation: string,
  startedAt: number,
  details: Record<string, unknown> = {},
  error?: unknown,
): void {
  const durationMs = Math.round(nowMs() - startedAt);
  const prefix = error ? "FAILED " : "";
  const message = `%c${prefix}IDB ${operation} | ${durationMs}ms${formatIdbLogDetail(details)}`;

  if (error) {
    console.error(message, "color: #38bdf8", error);
  } else {
    console.log(message, "color: #38bdf8");
  }
}

function staleConnectionError(event: IDBVersionChangeEvent): Error {
  const newVersion = event.newVersion === null ? "deleted" : event.newVersion;
  return new Error(
    `${STALE_CONNECTION_MESSAGE} (version changed from ${event.oldVersion} to ${newVersion})`,
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IDB transaction failed"));
  });
}

function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // Transaction may already be finished or aborting.
  }
}

function tableStoreName(tableName: string): string {
  return `${TABLE_STORE_PREFIX}${tableName}`;
}

function decodeStoredRecord(record: NativeStoredRecord): Row {
  return record.row as Row;
}

function createIndexSignature(tableDef: TableDefinition): string {
  return JSON.stringify({
    version: TABLE_INDEX_SIGNATURE_VERSION,
    layout: "native-table-store",
    rowStorage: "raw",
    sortKeyMode: tableDef.schemaValidator ? "scan" : "stored",
    indexes: Object.keys(tableDef.indexes).sort().map((indexName) => {
      const indexDef = tableDef.indexes[indexName];

      return {
        name: indexName,
        type: indexDef.type,
        cols: indexDef.cols.map(String),
      };
    }),
  });
}

function validateBatchIds(values: Row[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value.id !== "string") {
      throw new Error("Inserted records must have a string id");
    }
    if (seen.has(value.id)) {
      throw new Error(`Record with duplicate id already exists: ${value.id}`);
    }
    seen.add(value.id);
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

    if (bound.lte.some((value, index) => !Object.is(value, bound.gte?.[index]))) {
      throw new Error(
        `Hash index should have the same equality condition for columns '${indexColumn}' and index name '${indexName}'`,
      );
    }
  }
}

function createSortKeyRanges(
  tableDef: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
): (IDBKeyRange | undefined)[] {
  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) throw new Error(`Index ${indexName} not found`);

  const filterColumns = indexDef.cols.map(String);
  const sortColumns = sqliteIndexSortColumns(indexDef.cols);
  const mode = sqliteIndexSortKeyMode(tableDef, indexName);
  const rawBounds = convertWhereToBound(filterColumns, clauses);

  if (indexDef.type === "hash") {
    validateHashBounds(indexName, filterColumns, rawBounds);
  }

  const ranges: (IDBKeyRange | undefined)[] = [];

  for (const rawBound of rawBounds) {
    const bound = {
      gte: expandBoundTuple(rawBound.gte, sortColumns.length, MIN),
      gt: expandBoundTuple(rawBound.gt, sortColumns.length, MAX),
      lte: expandBoundTuple(rawBound.lte, sortColumns.length, MAX),
      lt: expandBoundTuple(rawBound.lt, sortColumns.length, MIN),
    };

    const lowerSortKey = bound.gte
      ? encodeSqliteSortKeyTuple(bound.gte, mode)
      : bound.gt
        ? encodeSqliteSortKeyTuple(bound.gt, mode)
        : undefined;
    const upperSortKey = bound.lte
      ? encodeSqliteSortKeyTuple(bound.lte, mode)
      : bound.lt
        ? encodeSqliteSortKeyTuple(bound.lt, mode)
        : undefined;

    if (lowerSortKey !== undefined && upperSortKey !== undefined) {
      ranges.push(
        IDBKeyRange.bound(
          lowerSortKey,
          upperSortKey,
          bound.gt !== undefined,
          bound.lt !== undefined,
        ),
      );
      continue;
    }

    if (lowerSortKey !== undefined) {
      ranges.push(IDBKeyRange.lowerBound(lowerSortKey, bound.gt !== undefined));
      continue;
    }

    if (upperSortKey !== undefined) {
      ranges.push(IDBKeyRange.upperBound(upperSortKey, bound.lt !== undefined));
      continue;
    }

    ranges.push(undefined);
  }

  return ranges;
}

function isIdOnlyIndex(tableDef: TableDefinition, indexName: string): boolean {
  const indexDef = tableDef.indexes[indexName];
  return indexDef?.cols.length === 1 && String(indexDef.cols[0]) === "id";
}

function isUnfilteredClauses(clauses: WhereClause[]): boolean {
  return clauses.every(
    (clause) =>
      (!clause.eq || clause.eq.length === 0) &&
      (!clause.gte || clause.gte.length === 0) &&
      (!clause.gt || clause.gt.length === 0) &&
      (!clause.lte || clause.lte.length === 0) &&
      (!clause.lt || clause.lt.length === 0),
  );
}

function exactIdFromClauses(clauses: WhereClause[]): string | undefined {
  if (clauses.length !== 1) return undefined;
  const [clause] = clauses;
  const hasRange =
    (clause.gte && clause.gte.length > 0) ||
    (clause.gt && clause.gt.length > 0) ||
    (clause.lte && clause.lte.length > 0) ||
    (clause.lt && clause.lt.length > 0);
  if (hasRange || !clause.eq || clause.eq.length !== 1) return undefined;

  const [condition] = clause.eq;
  return condition.col === "id" && typeof condition.val === "string"
    ? condition.val
    : undefined;
}

function sortAndLimitRecords(
  records: NativeStoredRecord[],
  indexName: string,
  selectOptions: SelectOptions,
): NativeStoredRecord[] {
  records.sort((left, right) => {
    const leftSortKey = left.indexes[indexName];
    const rightSortKey = right.indexes[indexName];
    if (leftSortKey < rightSortKey) return -1;
    if (leftSortKey > rightSortKey) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

  if (selectOptions.order === "desc") {
    records.reverse();
  }

  const seenIds = new Set<string>();
  const result: NativeStoredRecord[] = [];
  for (const record of records) {
    if (seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    result.push(record);
    if (
      selectOptions.limit !== undefined &&
      result.length >= selectOptions.limit
    ) {
      break;
    }
  }

  return result;
}

function indexKeyPath(indexName: string): string {
  return `indexes.${indexName}`;
}

function createNativeRecordFromRow(
  tableDef: TableDefinition,
  row: Row,
): NativeStoredRecord {
  const indexes: Record<string, string> = {};

  for (const indexName of Object.keys(tableDef.indexes)) {
    const sortKey = getSqliteIndexSortKeyValue(tableDef, indexName, row);
    if (sortKey !== null) {
      indexes[indexName] = sortKey;
    }
  }

  return {
    id: row.id,
    row,
    indexes,
  };
}

function createNativeRecord(
  tableDef: TableDefinition,
  row: Row,
): NativeStoredRecord {
  return createNativeRecordFromRow(tableDef, row);
}

function advanceRange(
  range: IDBKeyRange | undefined,
  lastKey: IDBValidKey,
  direction: IDBCursorDirection,
): IDBKeyRange {
  if (direction === "prev" || direction === "prevunique") {
    if (range?.lower !== undefined) {
      return IDBKeyRange.bound(range.lower, lastKey, range.lowerOpen, true);
    }
    return IDBKeyRange.upperBound(lastKey, true);
  }

  if (range?.upper !== undefined) {
    return IDBKeyRange.bound(lastKey, range.upper, true, range.upperOpen);
  }
  return IDBKeyRange.lowerBound(lastKey, true);
}

async function getAllRecords<T>(
  source: IDBObjectStore | IDBIndex,
  query: IDBKeyRange | undefined,
  options: { limit?: number; direction?: IDBCursorDirection } = {},
): Promise<T[]> {
  const getAllRecordsFn = (source as GetAllRecordsSource<T>).getAllRecords;
  const direction = options.direction ?? "next";

  if (typeof getAllRecordsFn === "function") {
    const results: T[] = [];
    let currentQuery = query;

    while (true) {
      const remaining =
        options.limit === undefined ? undefined : options.limit - results.length;
      if (remaining !== undefined && remaining <= 0) return results;

      const count =
        remaining === undefined
          ? IDB_READ_BATCH_SIZE
          : Math.min(remaining, IDB_READ_BATCH_SIZE);
      const records = await requestToPromise<IdbRecord<T>[]>(
        getAllRecordsFn.call(source, {
          query: currentQuery,
          count,
          direction,
        }),
      );

      results.push(...records.map((record) => record.value));
      if (records.length < count) return results;

      currentQuery = advanceRange(
        query,
        records[records.length - 1].key,
        direction,
      );
    }
  }

  if (source instanceof IDBIndex) {
    const canPushLimit = direction !== "prev" && direction !== "prevunique";
    const values = await requestToPromise(
      canPushLimit && options.limit !== undefined
        ? source.getAll(query, options.limit)
        : source.getAll(query),
    );
    const ordered =
      direction === "prev" || direction === "prevunique"
        ? [...values].reverse()
        : values;
    return options.limit === undefined
      ? (ordered as T[])
      : (ordered.slice(0, options.limit) as T[]);
  }

  const results: T[] = [];
  let currentQuery = query;

  while (true) {
    const remaining =
      options.limit === undefined ? undefined : options.limit - results.length;
    if (remaining !== undefined && remaining <= 0) return results;

    const count =
      direction === "prev" || direction === "prevunique"
        ? IDB_READ_BATCH_SIZE
        : remaining === undefined
          ? IDB_READ_BATCH_SIZE
          : Math.min(remaining, IDB_READ_BATCH_SIZE);
    const keysRequest = source.getAllKeys(currentQuery, count);
    const valuesRequest = source.getAll(currentQuery, count);
    const [keys, values] = await Promise.all([
      requestToPromise(keysRequest),
      requestToPromise(valuesRequest),
    ]);

    results.push(...(values as T[]));

    if (keys.length < count) {
      const ordered =
        direction === "prev" || direction === "prevunique"
          ? [...results].reverse()
          : results;
      return options.limit === undefined ? ordered : ordered.slice(0, options.limit);
    }

    currentQuery = advanceRange(currentQuery, keys[keys.length - 1], "next");
  }
}

class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private waitingReaders: Array<(release: LockRelease) => void> = [];
  private waitingWriters: Array<(release: LockRelease) => void> = [];

  acquireRead(): Promise<LockRelease> {
    if (!this.writerActive && this.waitingWriters.length === 0) {
      this.activeReaders++;
      return Promise.resolve(() => this.releaseRead());
    }

    return new Promise((resolve) => {
      this.waitingReaders.push(resolve);
    });
  }

  acquireWrite(): Promise<LockRelease> {
    if (!this.writerActive && this.activeReaders === 0) {
      this.writerActive = true;
      return Promise.resolve(() => this.releaseWrite());
    }

    return new Promise((resolve) => {
      this.waitingWriters.push(resolve);
    });
  }

  private releaseRead(): void {
    this.activeReaders--;
    this.drain();
  }

  private releaseWrite(): void {
    this.writerActive = false;
    this.drain();
  }

  private drain(): void {
    if (this.writerActive || this.activeReaders > 0) return;

    const writer = this.waitingWriters.shift();
    if (writer) {
      this.writerActive = true;
      writer(() => this.releaseWrite());
      return;
    }

    const readers = this.waitingReaders.splice(0);
    this.activeReaders = readers.length;
    for (const reader of readers) {
      reader(() => this.releaseRead());
    }
  }
}

async function performInsert(
  tx: IDBTransaction,
  tableDef: TableDefinition,
  values: Row[],
): Promise<void> {
  if (values.length === 0) return;
  const startedAt = nowMs();

  try {
    validateBatchIds(values);

    const store = tx.objectStore(tableStoreName(tableDef.tableName));
    const requests = values.map((value) =>
      requestToPromise(store.add(createNativeRecord(tableDef, value))),
    );
    await Promise.all(requests);
    logIdbOperation("insert", startedAt, {
      tableName: tableDef.tableName,
      rowCount: values.length,
    });
  } catch (error) {
    logIdbOperation(
      "insert",
      startedAt,
      {
        tableName: tableDef.tableName,
        rowCount: values.length,
      },
      error,
    );
    throw error;
  }
}

async function performUpsert(
  tx: IDBTransaction,
  tableDef: TableDefinition,
  values: Row[],
): Promise<void> {
  if (values.length === 0) return;
  const startedAt = nowMs();

  try {
    validateBatchIds(values);

    const store = tx.objectStore(tableStoreName(tableDef.tableName));
    const requests = values.map((value) =>
      requestToPromise(store.put(createNativeRecord(tableDef, value))),
    );
    await Promise.all(requests);
    logIdbOperation("upsert", startedAt, {
      tableName: tableDef.tableName,
      rowCount: values.length,
    });
  } catch (error) {
    logIdbOperation(
      "upsert",
      startedAt,
      {
        tableName: tableDef.tableName,
        rowCount: values.length,
      },
      error,
    );
    throw error;
  }
}

async function performDelete(
  tx: IDBTransaction,
  tableDef: TableDefinition,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const startedAt = nowMs();

  try {
    const store = tx.objectStore(tableStoreName(tableDef.tableName));
    const requests = ids.map((id) => requestToPromise(store.delete(id)));
    await Promise.all(requests);

    logIdbOperation("delete", startedAt, {
      tableName: tableDef.tableName,
      rowCount: ids.length,
    });
  } catch (error) {
    logIdbOperation(
      "delete",
      startedAt,
      {
        tableName: tableDef.tableName,
        rowCount: ids.length,
      },
      error,
    );
    throw error;
  }
}

async function performScan(
  tx: IDBTransaction,
  tableDefinitions: Map<string, TableDefinition>,
  tableName: string,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions,
): Promise<Row[]> {
  const tableDef = tableDefinitions.get(tableName);
  if (!tableDef) throw new Error(`Table ${tableName} not found`);

  const startedAt = nowMs();
  if (selectOptions.limit !== undefined && selectOptions.limit <= 0) {
    logIdbOperation("scan", startedAt, {
      tableName,
      indexName,
      rowCount: 0,
    });
    return [];
  }

  try {
    const store = tx.objectStore(tableStoreName(tableName));
    const direction: IDBCursorDirection =
      selectOptions.order === "desc" ? "prev" : "next";

    if (isIdOnlyIndex(tableDef, indexName)) {
      const exactId = exactIdFromClauses(clauses);
      if (exactId !== undefined) {
        const record = await requestToPromise<NativeStoredRecord | undefined>(
          store.get(exactId),
        );
        const result = record ? [decodeStoredRecord(record)] : [];
        logIdbOperation("scan", startedAt, {
          tableName,
          indexName,
          rowCount: result.length,
        });
        return result;
      }

      if (
        isUnfilteredClauses(clauses) &&
        selectOptions.limit === undefined
      ) {
        const records = await getAllRecords<NativeStoredRecord>(store, undefined, {
          direction,
        });
        const result = records.map(decodeStoredRecord);
        logIdbOperation("scan", startedAt, {
          tableName,
          indexName,
          rowCount: result.length,
        });
        return result;
      }
    }

    const index = store.index(indexName);
    const ranges = createSortKeyRanges(tableDef, indexName, clauses);
    const canPushLimit = ranges.length === 1;
    const records: NativeStoredRecord[] = [];

    for (const range of ranges) {
      const remaining =
        canPushLimit && selectOptions.limit !== undefined
          ? selectOptions.limit - records.length
          : undefined;
      if (remaining !== undefined && remaining <= 0) break;

      records.push(
        ...(await getAllRecords<NativeStoredRecord>(index, range, {
          direction,
          limit: remaining,
        })),
      );
    }

    const sorted = sortAndLimitRecords(records, indexName, selectOptions);
    const result = sorted.map(decodeStoredRecord);

    logIdbOperation("scan", startedAt, {
      tableName,
      indexName,
      rowCount: result.length,
    });
    return result;
  } catch (error) {
    logIdbOperation(
      "scan",
      startedAt,
      {
        tableName,
        indexName,
      },
      error,
    );
    throw new Error(`Scan failed for index ${indexName}: ${error}`);
  }
}

class IdbDriverTx implements DBDriverTX {
  private tx: IDBTransaction;
  private tableDefinitions: Map<string, TableDefinition>;
  private onFinish: () => void;
  private committed = false;
  private rolledback = false;
  private done: Promise<void>;
  private startedAt: number;

  constructor(
    tx: IDBTransaction,
    tableDefinitions: Map<string, TableDefinition>,
    onFinish: () => void,
    startedAt: number,
  ) {
    this.tx = tx;
    this.tableDefinitions = tableDefinitions;
    this.onFinish = onFinish;
    this.done = txDone(tx);
    this.startedAt = startedAt;
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.committed = true;

    yield* unwrapCb(async () => {
      try {
        this.tx.commit?.();
        await this.done;
        logIdbOperation("transaction commit", this.startedAt, {
          mode: this.tx.mode,
        });
      } catch (error) {
        logIdbOperation(
          "transaction commit",
          this.startedAt,
          {
            mode: this.tx.mode,
          },
          error,
        );
        throw error;
      } finally {
        this.onFinish();
      }
    });
  }

  *rollback(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.rolledback = true;

    yield* unwrapCb(async () => {
      abortQuietly(this.tx);
      try {
        await this.done;
      } catch {
        // Abort is the expected rollback path.
      } finally {
        logIdbOperation("transaction rollback", this.startedAt, {
          mode: this.tx.mode,
        });
        this.onFinish();
      }
    });
  }

  *insert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    this.throwIfDone();
    const tableDef = this.getTableDefinition(tableName);
    yield* unwrapCb(async () => {
      await performInsert(this.tx, tableDef, values);
    });
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    this.throwIfDone();
    const tableDef = this.getTableDefinition(tableName);
    yield* unwrapCb(async () => {
      await performUpsert(this.tx, tableDef, values);
    });
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    this.throwIfDone();
    const tableDef = this.getTableDefinition(tableName);
    yield* unwrapCb(async () => {
      await performDelete(this.tx, tableDef, values);
    });
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    this.throwIfDone();

    return yield* unwrapCb(async () =>
      performScan(
        this.tx,
        this.tableDefinitions,
        table,
        indexName,
        clauses,
        selectOptions,
      ),
    );
  }

  private getTableDefinition(tableName: string): TableDefinition {
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    return tableDef;
  }

  private throwIfDone(): void {
    if (this.committed || this.rolledback) {
      throw new Error("Transaction already finished");
    }
  }
}

export class IdbDriver implements DBDriver {
  private db: IDBDatabase;
  private readonly dbName: string;
  private readonly factory: IDBFactory;
  private readonly options: OpenIndexedDBDriverOptions;
  private tableDefinitions = new Map<string, TableDefinition>();
  private lock = new AsyncReadWriteLock();
  private closedReason: Error | null = null;

  constructor(
    dbName: string,
    db: IDBDatabase,
    factory: IDBFactory,
    options: OpenIndexedDBDriverOptions = {},
  ) {
    this.dbName = dbName;
    this.db = db;
    this.factory = factory;
    this.options = options;
    this.attachVersionChangeHandler();
  }

  close(reason: Error = new Error("IndexedDB connection is closed")): void {
    if (!this.closedReason) {
      this.closedReason = reason;
    }
    this.db.close();
  }

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    const release = yield* unwrapCb(async () => this.lock.acquireWrite());

    let tx: IDBTransaction;
    try {
      this.throwIfClosed();
      const storeNames = this.loadedStoreNames();
      const startedAt = nowMs();
      tx = this.createTransaction(storeNames, "readwrite");
      logIdbOperation("transaction start", startedAt, {
        mode: tx.mode,
      });
      return new IdbDriverTx(tx, this.tableDefinitions, release, startedAt);
    } catch (error) {
      release();
      throw error;
    }
  }

  *loadTables(tableDefinitions: TableDefinition<any>[]): Generator<DBCmd, void> {
    yield* unwrapCb(async () => {
      const release = await this.lock.acquireWrite();
      try {
        this.throwIfClosed();
        for (const tableDef of tableDefinitions) {
          assertSafeTableDefinition(tableDef);
        }

        await this.ensureSchema(tableDefinitions);
        await this.refreshTableMetadata(tableDefinitions);

        for (const tableDef of tableDefinitions) {
          this.tableDefinitions.set(tableDef.tableName, tableDef);
        }
      } finally {
        release();
      }
    });
  }

  *insert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", [tableStoreName(tableName)], async (tx) => {
      await performInsert(tx, tableDef, values);
    });
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", [tableStoreName(tableName)], async (tx) => {
      await performUpsert(tx, tableDef, values);
    });
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", [tableStoreName(tableName)], async (tx) => {
      await performDelete(tx, tableDef, values);
    });
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    return yield* this.withTransaction(
      "readonly",
      [tableStoreName(table)],
      async (tx) =>
        performScan(
          tx,
          this.tableDefinitions,
          table,
          indexName,
          clauses,
          selectOptions,
        ),
    );
  }

  private async ensureSchema(
    tableDefinitions: TableDefinition<any>[],
  ): Promise<void> {
    if (!(await this.needsSchemaUpgrade(tableDefinitions))) return;

    const nextVersion = this.db.version + 1;
    this.db.close();
    this.db = await openRequestToPromise(
      this.factory.open(this.dbName, nextVersion),
      this.options,
      (db, tx) => applySchemaUpgrade(db, tx, tableDefinitions),
    );
    this.attachVersionChangeHandler();
  }

  private async needsSchemaUpgrade(
    tableDefinitions: TableDefinition<any>[],
  ): Promise<boolean> {
    if (!this.db.objectStoreNames.contains(TABLE_METADATA_STORE)) return true;
    if (this.db.objectStoreNames.contains(OLD_ROWS_STORE)) return true;
    if (this.db.objectStoreNames.contains(OLD_INDEX_ENTRIES_STORE)) return true;

    for (const tableDef of tableDefinitions) {
      const storeName = tableStoreName(tableDef.tableName);
      if (!this.db.objectStoreNames.contains(storeName)) return true;

      const tx = this.db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const expectedIndexes = new Set(Object.keys(tableDef.indexes));
      const actualIndexes = Array.from(store.indexNames);
      let storeNeedsUpgrade = actualIndexes.length !== expectedIndexes.size;

      for (const indexName of actualIndexes) {
        if (!expectedIndexes.has(indexName)) {
          storeNeedsUpgrade = true;
          continue;
        }
        if (store.index(indexName).keyPath !== indexKeyPath(indexName)) {
          storeNeedsUpgrade = true;
        }
      }
      await txDone(tx);
      if (storeNeedsUpgrade) return true;
    }

    return false;
  }

  private async refreshTableMetadata(
    tableDefinitions: TableDefinition<any>[],
  ): Promise<void> {
    const storeNames = [
      TABLE_METADATA_STORE,
      ...tableDefinitions.map((tableDef) => tableStoreName(tableDef.tableName)),
    ];
    const tx = this.createTransaction(storeNames, "readwrite");
    const done = txDone(tx);

    try {
      const metadataStore = tx.objectStore(TABLE_METADATA_STORE);

      for (const tableDef of tableDefinitions) {
        const indexSignature = createIndexSignature(tableDef);
        const metadata = await requestToPromise<
          StoredTableMetadata | undefined
        >(metadataStore.get(tableDef.tableName));

        if (metadata?.indexSignature !== indexSignature) {
          await this.rewriteTableRecords(tx, tableDef);
          await requestToPromise(
            metadataStore.put({
              tableName: tableDef.tableName,
              indexSignature,
            } satisfies StoredTableMetadata),
          );
        }
      }

      tx.commit?.();
      await done;
    } catch (error) {
      abortQuietly(tx);
      try {
        await done;
      } catch {
        // Preserve original metadata refresh error.
      }
      throw error;
    }
  }

  private async rewriteTableRecords(
    tx: IDBTransaction,
    tableDef: TableDefinition,
  ): Promise<void> {
    const startedAt = nowMs();
    const store = tx.objectStore(tableStoreName(tableDef.tableName));
    const records = await getAllRecords<NativeStoredRecord>(store, undefined);
    const requests = records.map((record) =>
      requestToPromise(
        store.put(
          createNativeRecordFromRow(
            tableDef,
            decodeValueFromStorage(record.row) as Row,
          ),
        ),
      ),
    );
    await Promise.all(requests);
    logIdbOperation("rebuild indexes", startedAt, {
      tableName: tableDef.tableName,
      rowCount: records.length,
    });
  }

  private createTransaction(
    storeNames: string[],
    mode: StoreMode,
  ): IDBTransaction {
    const options =
      mode === "readwrite"
        ? { durability: this.options.durability ?? "relaxed" }
        : undefined;
    return this.db.transaction(storeNames, mode, options);
  }

  private getTableDefinition(tableName: string): TableDefinition {
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    return tableDef;
  }

  private loadedStoreNames(): string[] {
    const storeNames = [...this.tableDefinitions.keys()].map(tableStoreName);
    if (storeNames.length === 0) {
      throw new Error("No tables loaded");
    }
    return storeNames;
  }

  private throwIfClosed(): void {
    if (this.closedReason) {
      throw this.closedReason;
    }
  }

  private *withTransaction<T>(
    mode: StoreMode,
    storeNames: string[],
    run: (tx: IDBTransaction) => Promise<T>,
  ): Generator<DBCmd, T> {
    return yield* unwrapCb(async () => {
      const release =
        mode === "readonly"
          ? await this.lock.acquireRead()
          : await this.lock.acquireWrite();
      let tx: IDBTransaction | undefined;
      let done: Promise<void> | undefined;
      const transactionStartedAt = nowMs();

      try {
        this.throwIfClosed();
        tx = this.createTransaction(storeNames, mode);
        logIdbOperation("transaction start", transactionStartedAt, {
          mode,
        });
        done = txDone(tx);
        const result = await run(tx);
        tx.commit?.();
        await done;
        logIdbOperation("transaction commit", transactionStartedAt, {
          mode,
        });
        return result;
      } catch (error) {
        if (tx !== undefined && done !== undefined) {
          abortQuietly(tx);
          try {
            await done;
          } catch {
            // Preserve the original operation error.
          }
          logIdbOperation("transaction rollback", transactionStartedAt, {
            mode,
          });
        } else {
          logIdbOperation(
            "transaction start",
            transactionStartedAt,
            {
              mode,
            },
            error,
          );
        }
        throw error;
      } finally {
        release();
      }
    });
  }

  private attachVersionChangeHandler(): void {
    this.db.onversionchange = (event) => {
      this.options.onVersionChange?.(event);
      this.close(staleConnectionError(event));
    };
  }
}

function applyBaseUpgrade(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(OLD_ROWS_STORE)) {
    db.deleteObjectStore(OLD_ROWS_STORE);
  }
  if (db.objectStoreNames.contains(OLD_INDEX_ENTRIES_STORE)) {
    db.deleteObjectStore(OLD_INDEX_ENTRIES_STORE);
  }
  if (!db.objectStoreNames.contains(TABLE_METADATA_STORE)) {
    db.createObjectStore(TABLE_METADATA_STORE, {
      keyPath: "tableName",
    });
  }
}

function applySchemaUpgrade(
  db: IDBDatabase,
  tx: IDBTransaction,
  tableDefinitions: TableDefinition<any>[],
): void {
  const resetOldLayout =
    db.objectStoreNames.contains(OLD_ROWS_STORE) ||
    db.objectStoreNames.contains(OLD_INDEX_ENTRIES_STORE);

  if (resetOldLayout && db.objectStoreNames.contains(TABLE_METADATA_STORE)) {
    db.deleteObjectStore(TABLE_METADATA_STORE);
  }

  applyBaseUpgrade(db);

  for (const tableDef of tableDefinitions) {
    const storeName = tableStoreName(tableDef.tableName);
    const store = db.objectStoreNames.contains(storeName)
      ? tx.objectStore(storeName)
      : db.createObjectStore(storeName, { keyPath: "id" });
    const expectedIndexes = new Set(Object.keys(tableDef.indexes));

    for (const indexName of Array.from(store.indexNames)) {
      if (
        !expectedIndexes.has(indexName) ||
        store.index(indexName).keyPath !== indexKeyPath(indexName)
      ) {
        store.deleteIndex(indexName);
      }
    }

    for (const indexName of expectedIndexes) {
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, indexKeyPath(indexName));
      }
    }
  }
}

function openRequestToPromise(
  request: IDBOpenDBRequest,
  options: Pick<OpenIndexedDBDriverOptions, "onBlocked"> = {},
  upgrade: (db: IDBDatabase, tx: IDBTransaction) => void = applyBaseUpgrade,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      if (!request.transaction) {
        reject(new Error("IndexedDB upgrade transaction is missing"));
        return;
      }
      upgrade(request.result, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB database"));
    request.onblocked = (event) => {
      options.onBlocked?.(event);
    };
  });
}

export async function openIndexedDBDriver(
  dbName: string,
  options: OpenIndexedDBDriverOptions = {},
): Promise<IdbDriver> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error("IndexedDB is not available in this environment");
  }

  const request =
    options.version === undefined
      ? factory.open(dbName)
      : factory.open(dbName, options.version);
  const db = await openRequestToPromise(request, options);
  return new IdbDriver(dbName, db, factory, options);
}
