/* eslint-disable @typescript-eslint/no-explicit-any */
import AwaitLock from "await-lock";
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
import {
  decodeValueFromStorage,
  encodeValueForStorage,
} from "../../storage/codec";
import {
  assertSafeTableDefinition,
  sqliteIndexSortColumns,
  sqliteIndexSortKeyMode,
  getSqliteIndexSortKeyValue,
} from "../sqlite/sqlite-common";
import { encodeSqliteSortKeyTuple } from "../sqlite/sqlite-sort-key";

type StoredRow = {
  tableName: string;
  id: string;
  data: unknown;
};

type StoredIndexEntry = {
  tableName: string;
  indexName: string;
  sortKey: string;
  id: string;
  data?: unknown;
};

type StoredTableMetadata = {
  tableName: string;
  indexSignature: string;
};

type StoreMode = "readonly" | "readwrite";

export type OpenIndexedDBDriverOptions = {
  indexedDB?: IDBFactory;
  version?: number;
  onBlocked?: (event: IDBVersionChangeEvent) => void;
  onVersionChange?: (event: IDBVersionChangeEvent) => void;
};

const ROWS_STORE = "rows";
const INDEX_ENTRIES_STORE = "indexEntries";
const TABLE_METADATA_STORE = "tableMetadata";
const DEFAULT_VERSION = 2;
const TABLE_INDEX_SIGNATURE_VERSION = 2;
const IDB_READ_BATCH_SIZE = 1000;
const STALE_CONNECTION_MESSAGE =
  "IndexedDB connection is stale; reopen the driver";

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

function decodeStoredRow(row: StoredRow): Row {
  return decodeValueFromStorage(row.data) as Row;
}

function createIndexSignature(tableDef: TableDefinition): string {
  return JSON.stringify({
    version: TABLE_INDEX_SIGNATURE_VERSION,
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
): IDBKeyRange[] {
  const indexDef = tableDef.indexes[indexName];
  if (!indexDef) throw new Error(`Index ${indexName} not found`);

  const filterColumns = indexDef.cols.map(String);
  const sortColumns = sqliteIndexSortColumns(indexDef.cols);
  const mode = sqliteIndexSortKeyMode(tableDef, indexName);
  const rawBounds = convertWhereToBound(filterColumns, clauses);

  if (indexDef.type === "hash") {
    validateHashBounds(indexName, filterColumns, rawBounds);
  }

  const ranges: IDBKeyRange[] = [];

  for (const rawBound of rawBounds) {
    const bound = {
      gte: expandBoundTuple(rawBound.gte, sortColumns.length, MIN),
      gt: expandBoundTuple(rawBound.gt, sortColumns.length, MAX),
      lte: expandBoundTuple(rawBound.lte, sortColumns.length, MAX),
      lt: expandBoundTuple(rawBound.lt, sortColumns.length, MIN),
    };

    if (!bound.gte && !bound.gt && !bound.lte && !bound.lt) {
      ranges.push(
        IDBKeyRange.bound(
          [tableDef.tableName, indexName],
          [tableDef.tableName, indexName, []],
        ),
      );
      continue;
    }

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

    const lower = lowerSortKey
      ? bound.gt
        ? [tableDef.tableName, indexName, lowerSortKey, []]
        : [tableDef.tableName, indexName, lowerSortKey]
      : [tableDef.tableName, indexName];
    const upper = upperSortKey
      ? bound.lt
        ? [tableDef.tableName, indexName, upperSortKey]
        : [tableDef.tableName, indexName, upperSortKey, []]
      : [tableDef.tableName, indexName, []];

    ranges.push(IDBKeyRange.bound(lower, upper));
  }

  return ranges;
}

function sortedUniqueEntries(
  entries: StoredIndexEntry[],
  selectOptions: SelectOptions,
): StoredIndexEntry[] {
  entries.sort((left, right) => {
    if (left.sortKey < right.sortKey) return -1;
    if (left.sortKey > right.sortKey) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

  if (selectOptions.order === "desc") {
    entries.reverse();
  }

  const seenIds = new Set<string>();
  const result: StoredIndexEntry[] = [];
  for (const entry of entries) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    result.push(entry);
    if (
      selectOptions.limit !== undefined &&
      result.length >= selectOptions.limit
    ) {
      break;
    }
  }

  return result;
}

async function getAllFromCursor<T>(
  store: IDBObjectStore,
  range: IDBKeyRange,
): Promise<T[]> {
  const results: T[] = [];
  let currentRange = range;

  while (true) {
    const keysRequest = store.getAllKeys(currentRange, IDB_READ_BATCH_SIZE);
    const valuesRequest = store.getAll(currentRange, IDB_READ_BATCH_SIZE);
    const [keys, values] = await Promise.all([
      requestToPromise(keysRequest),
      requestToPromise(valuesRequest),
    ]);

    results.push(...(values as T[]));

    if (keys.length < IDB_READ_BATCH_SIZE) {
      return results;
    }

    const lastKey = keys[keys.length - 1];
    currentRange =
      range.upper === undefined
        ? IDBKeyRange.lowerBound(lastKey, true)
        : IDBKeyRange.bound(lastKey, range.upper, true, range.upperOpen);
  }
}

async function deleteFromCursor(
  store: IDBObjectStore,
  range: IDBKeyRange,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range);

    request.onerror = () =>
      reject(request.error ?? new Error("IDB cursor delete failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    };
  });
}

function tableRange(tableName: string): IDBKeyRange {
  return IDBKeyRange.bound([tableName], [tableName, []]);
}

function rowKey(tableName: string, id: string): [string, string] {
  return [tableName, id];
}

function indexEntriesForRow(
  tableDef: TableDefinition,
  row: Row,
): StoredIndexEntry[] {
  const storageRow = encodeValueForStorage(row) as Row;
  const result: StoredIndexEntry[] = [];

  for (const indexName of Object.keys(tableDef.indexes)) {
    const sortKey = getSqliteIndexSortKeyValue(tableDef, indexName, storageRow);
    if (sortKey === null) continue;

    result.push({
      tableName: tableDef.tableName,
      indexName,
      sortKey,
      id: storageRow.id,
      data: storageRow,
    });
  }

  return result;
}

async function deleteIndexEntriesForRow(
  entriesStore: IDBObjectStore,
  tableDef: TableDefinition,
  row: Row,
): Promise<void> {
  for (const entry of indexEntriesForRow(tableDef, row)) {
    await requestToPromise(
      entriesStore.delete([
        entry.tableName,
        entry.indexName,
        entry.sortKey,
        entry.id,
      ]),
    );
  }
}

async function writeRow(
  rowsStore: IDBObjectStore,
  entriesStore: IDBObjectStore,
  tableDef: TableDefinition,
  row: Row,
  mode: "add" | "put",
): Promise<void> {
  const storageRow = encodeValueForStorage(row) as Row;
  const record: StoredRow = {
    tableName: tableDef.tableName,
    id: storageRow.id,
    data: storageRow,
  };

  await requestToPromise(
    mode === "add" ? rowsStore.add(record) : rowsStore.put(record),
  );

  for (const entry of indexEntriesForRow(tableDef, row)) {
    await requestToPromise(entriesStore.put(entry));
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

    const rowsStore = tx.objectStore(ROWS_STORE);
    const entriesStore = tx.objectStore(INDEX_ENTRIES_STORE);
    for (const value of values) {
      await writeRow(rowsStore, entriesStore, tableDef, value, "add");
    }
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

    const rowsStore = tx.objectStore(ROWS_STORE);
    const entriesStore = tx.objectStore(INDEX_ENTRIES_STORE);
    for (const value of values) {
      const existing = await requestToPromise<StoredRow | undefined>(
        rowsStore.get(rowKey(tableDef.tableName, value.id)),
      );
      if (existing) {
        await deleteIndexEntriesForRow(
          entriesStore,
          tableDef,
          decodeStoredRow(existing),
        );
      }
      await writeRow(rowsStore, entriesStore, tableDef, value, "put");
    }
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
  let deletedCount = 0;

  try {
    const rowsStore = tx.objectStore(ROWS_STORE);
    const entriesStore = tx.objectStore(INDEX_ENTRIES_STORE);
    for (const id of ids) {
      const existing = await requestToPromise<StoredRow | undefined>(
        rowsStore.get(rowKey(tableDef.tableName, id)),
      );
      if (!existing) continue;

      await deleteIndexEntriesForRow(
        entriesStore,
        tableDef,
        decodeStoredRow(existing),
      );
      await requestToPromise(rowsStore.delete(rowKey(tableDef.tableName, id)));
      deletedCount++;
    }

    logIdbOperation("delete", startedAt, {
      tableName: tableDef.tableName,
      rowCount: deletedCount,
    });
  } catch (error) {
    logIdbOperation(
      "delete",
      startedAt,
      {
        tableName: tableDef.tableName,
        rowCount: deletedCount,
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
    const entriesStore = tx.objectStore(INDEX_ENTRIES_STORE);
    const rowsStore = tx.objectStore(ROWS_STORE);
    const entries: StoredIndexEntry[] = [];

    for (const range of createSortKeyRanges(tableDef, indexName, clauses)) {
      entries.push(
        ...(await getAllFromCursor<StoredIndexEntry>(entriesStore, range)),
      );
    }

    const result: Row[] = [];
    for (const entry of sortedUniqueEntries(entries, selectOptions)) {
      if (entry.data !== undefined) {
        result.push(decodeValueFromStorage(entry.data) as Row);
        continue;
      }

      const storedRow = await requestToPromise<StoredRow | undefined>(
        rowsStore.get(rowKey(tableName, entry.id)),
      );
      if (storedRow) {
        result.push(decodeStoredRow(storedRow));
      }
    }

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
        this.onFinish();
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
      }
      logIdbOperation("transaction rollback", this.startedAt, {
        mode: this.tx.mode,
      });
      this.onFinish();
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
  private tableDefinitions = new Map<string, TableDefinition>();
  private lock = new AwaitLock();
  private closedReason: Error | null = null;

  constructor(
    db: IDBDatabase,
    options: Pick<OpenIndexedDBDriverOptions, "onVersionChange"> = {},
  ) {
    this.db = db;
    this.db.onversionchange = (event) => {
      options.onVersionChange?.(event);
      this.close(staleConnectionError(event));
    };
  }

  close(reason: Error = new Error("IndexedDB connection is closed")): void {
    if (!this.closedReason) {
      this.closedReason = reason;
    }
    this.db.close();
  }

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    yield* unwrapCb(async () => {
      await this.lock.acquireAsync();
    });

    let tx: IDBTransaction;
    try {
      this.throwIfClosed();
      const startedAt = nowMs();
      tx = this.db.transaction([ROWS_STORE, INDEX_ENTRIES_STORE], "readwrite");
      logIdbOperation("transaction start", startedAt, {
        mode: tx.mode,
      });
      return new IdbDriverTx(tx, this.tableDefinitions, () => {
        this.lock.release();
      }, startedAt);
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  *loadTables(tableDefinitions: TableDefinition<any>[]): Generator<DBCmd, void> {
    yield* this.withTransaction(
      "readwrite",
      async (tx) => {
        for (const tableDef of tableDefinitions) {
          assertSafeTableDefinition(tableDef);
        }

        const rowsStore = tx.objectStore(ROWS_STORE);
        const entriesStore = tx.objectStore(INDEX_ENTRIES_STORE);
        const metadataStore = tx.objectStore(TABLE_METADATA_STORE);

        for (const tableDef of tableDefinitions) {
          const indexSignature = createIndexSignature(tableDef);
          const metadata = await requestToPromise<
            StoredTableMetadata | undefined
          >(metadataStore.get(tableDef.tableName));

          if (metadata?.indexSignature === indexSignature) {
            this.tableDefinitions.set(tableDef.tableName, tableDef);
            continue;
          }

          const startedAt = nowMs();
          await deleteFromCursor(entriesStore, tableRange(tableDef.tableName));
          const rows = await getAllFromCursor<StoredRow>(
            rowsStore,
            tableRange(tableDef.tableName),
          );

          for (const row of rows) {
            for (const entry of indexEntriesForRow(
              tableDef,
              decodeStoredRow(row),
            )) {
              await requestToPromise(entriesStore.put(entry));
            }
          }

          await requestToPromise(
            metadataStore.put({
              tableName: tableDef.tableName,
              indexSignature,
            } satisfies StoredTableMetadata),
          );
          this.tableDefinitions.set(tableDef.tableName, tableDef);
          logIdbOperation("rebuild indexes", startedAt, {
            tableName: tableDef.tableName,
            rowCount: rows.length,
          });
        }
      },
      [TABLE_METADATA_STORE],
    );
  }

  *insert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", async (tx) => {
      await performInsert(tx, tableDef, values);
    });
  }

  *upsert(tableName: string, values: Row[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", async (tx) => {
      await performUpsert(tx, tableDef, values);
    });
  }

  *delete(tableName: string, values: string[]): Generator<DBCmd, void> {
    if (values.length === 0) return;
    const tableDef = this.getTableDefinition(tableName);
    yield* this.withTransaction("readwrite", async (tx) => {
      await performDelete(tx, tableDef, values);
    });
  }

  *intervalScan(
    table: string,
    indexName: string,
    clauses: WhereClause[],
    selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    return yield* this.withTransaction("readonly", async (tx) =>
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

  private getTableDefinition(tableName: string): TableDefinition {
    const tableDef = this.tableDefinitions.get(tableName);
    if (!tableDef) throw new Error(`Table ${tableName} not found`);
    return tableDef;
  }

  private throwIfClosed(): void {
    if (this.closedReason) {
      throw this.closedReason;
    }
  }

  private *withTransaction<T>(
    mode: StoreMode,
    run: (tx: IDBTransaction) => Promise<T>,
    extraStores: string[] = [],
  ): Generator<DBCmd, T> {
    return yield* unwrapCb(async () => {
      await this.lock.acquireAsync();
      let tx: IDBTransaction | undefined;
      let done: Promise<void> | undefined;
      const transactionStartedAt = nowMs();

      try {
        this.throwIfClosed();
        tx = this.db.transaction(
          [ROWS_STORE, INDEX_ENTRIES_STORE, ...extraStores],
          mode,
        );
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
        this.lock.release();
      }
    });
  }
}

function openRequestToPromise(
  request: IDBOpenDBRequest,
  options: Pick<OpenIndexedDBDriverOptions, "onBlocked"> = {},
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROWS_STORE)) {
        db.createObjectStore(ROWS_STORE, {
          keyPath: ["tableName", "id"],
        });
      }
      if (!db.objectStoreNames.contains(INDEX_ENTRIES_STORE)) {
        db.createObjectStore(INDEX_ENTRIES_STORE, {
          keyPath: ["tableName", "indexName", "sortKey", "id"],
        });
      }
      if (!db.objectStoreNames.contains(TABLE_METADATA_STORE)) {
        db.createObjectStore(TABLE_METADATA_STORE, {
          keyPath: "tableName",
        });
      }
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

  const db = await openRequestToPromise(
    factory.open(dbName, options.version ?? DEFAULT_VERSION),
    options,
  );
  return new IdbDriver(db, options);
}
