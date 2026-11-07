import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
import { execMaybeAsync } from "../core/executor";
import type {
  HyperDB,
  HyperDBTx,
  HybridPreloadTableSpecInput,
  ValidateHybridPreloadTableSpecs,
} from "../core/contracts";
import type { DBTransactionMode } from "../core/driver";
import type {
  Row,
  SelectOptions,
  Trait,
  WhereClause,
} from "../core/primitives";
import {
  getCurrentSelectEventForDB,
  getDriverTraceContextForDB,
  type HyperDBTracerOption,
  withDriverTraceContextTrait,
} from "../core/tracer";
import type {
  ExtractIndexes,
  ExtractSchema,
  ExtractSchemaInput,
  TableDefinition,
} from "../schema/table";
import {
  DEFAULT_CODEC_OPTIONS,
  normalizeRecordsForDriver,
  type CodecOptions,
} from "../storage/codec";
import { deepFreeze } from "../deep-freeze";
import {
  HybridPersistenceQueue,
  type HybridPendingWrite,
} from "./hybrid-persistence";
import {
  HashIndex,
  HashIndexTx,
  type HashIndexEntry,
  type HashIndexView,
} from "../structures/hash-index";
import { refVar, type RefVar } from "../utils";
import AwaitLock from "../utils/await-lock";
import type { DB } from "./db";
import {
  hashScanValues,
  PreloadedTableIndexes,
} from "./preloaded-hybrid-db-indexes";
import { DuplicateIdError, HyperDBError } from "../core/errors";

const entityLoadBatchSize = 500;

export const externalStorageMergeTrait = {
  type: "external-storage-merge",
} as const satisfies Trait;

const usesExternalStorageMerge = (db: HyperDB): boolean =>
  db.getTraits().some((trait) => trait.type === externalStorageMergeTrait.type);

type EntityEntry =
  | { id: string; loaded: false }
  | { id: string; loaded: true; row: Row | null };

type EntityHashIndex = HashIndex<EntityEntry> | HashIndexTx<EntityEntry>;

function entityPointers(rows: readonly Row[]): HashIndexEntry<EntityEntry>[] {
  return rows.map((row) => ({
    key: row.id,
    id: row.id,
    value: { id: row.id, loaded: false },
  }));
}

function loadedEntities(rows: readonly Row[]): HashIndexEntry<EntityEntry>[] {
  return rows.map((row) => ({
    key: row.id,
    id: row.id,
    value: { id: row.id, loaded: true, row },
  }));
}

function entityById(
  index: HashIndexView<EntityEntry>,
  id: string,
): EntityEntry | undefined {
  return index.scan([id], { limit: 1 })[0];
}

function forkEntityHashIndex(
  index: EntityHashIndex,
  tableName: string,
): HashIndexTx<EntityEntry> {
  if (!(index instanceof HashIndex)) {
    throw new Error(`Cannot fork table transaction ${tableName}`);
  }
  return index.tx();
}

type PreloadedTableState = {
  indexes: PreloadedTableIndexes;
  byId: EntityHashIndex;
};

class PreloadedHybridData {
  readonly tables = new Map<string, PreloadedTableState>();

  get(table: TableDefinition): PreloadedTableState {
    const state = this.tables.get(table.tableName);
    if (!state)
      throw new HyperDBError(
        "TABLE_NOT_FOUND",
        `Table ${table.tableName} not found`,
      );
    return state;
  }

  fork(): PreloadedHybridData {
    const fork = new PreloadedHybridData();
    for (const [tableName, state] of this.tables) {
      fork.tables.set(tableName, {
        indexes: state.indexes.fork(),
        byId: forkEntityHashIndex(state.byId, tableName),
      });
    }
    return fork;
  }

  materializeFork(): void {
    for (const state of this.tables.values()) {
      state.indexes.materializeFork();
      if (state.byId instanceof HashIndexTx) state.byId = state.byId.commit();
    }
  }

  discardFork(): void {
    for (const state of this.tables.values()) {
      state.indexes.discardFork();
      if (state.byId instanceof HashIndexTx) state.byId = state.byId.rollback();
    }
  }
}

type PreloadedHybridDBState = {
  data: PreloadedHybridData;
  lock: AwaitLock;
  persistence: HybridPersistenceQueue;
};

const createState = (): PreloadedHybridDBState => ({
  data: new PreloadedHybridData(),
  lock: new AwaitLock(),
  persistence: new HybridPersistenceQueue(),
});

export type PreloadedHybridDBOptions = {
  traits?: Trait[];
  preloadConcurrency?: number | "whole";
};

type TablePreloadResult =
  | {
      status: "fulfilled";
      table: TableDefinition;
      state: PreloadedTableState;
    }
  | { status: "rejected"; table: TableDefinition; reason: unknown };

function normalizePreloadConcurrency(
  concurrency: number | "whole" | undefined,
): number | "whole" {
  if (concurrency === undefined || concurrency === "whole") return "whole";
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('preloadConcurrency must be "whole" or a positive integer');
  }
  return concurrency;
}

function createPreloadedTableState(
  table: TableDefinition,
  rows: Row[],
): PreloadedTableState {
  const byId = new HashIndex<EntityEntry>({
    name: table.idIndexName,
    unique: true,
  });
  byId.insert(entityPointers(rows));
  return {
    indexes: new PreloadedTableIndexes(table, rows),
    byId,
  };
}

async function preloadTablesConcurrently(
  primary: DB,
  tables: TableDefinition[],
  concurrency: number,
): Promise<TablePreloadResult[]> {
  const results = new Array<TablePreloadResult>(tables.length);
  let nextTableIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextTableIndex < tables.length) {
      const tableIndex = nextTableIndex++;
      const table = tables[tableIndex]!;
      try {
        const pendingRows = execMaybeAsync(primary.scanAll(table));
        const rows =
          pendingRows instanceof Promise ? await pendingRows : pendingRows;
        results[tableIndex] = {
          status: "fulfilled",
          table,
          state: createPreloadedTableState(table, rows as Row[]),
        };
      } catch (reason) {
        results[tableIndex] = { status: "rejected", table, reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tables.length) }, worker),
  );
  return results;
}

function* acquireLock(lock: AwaitLock): Generator<DBCmd, () => void> {
  if (!lock.tryAcquire()) yield* unwrap(lock.acquireAsync());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.release();
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function* scanPreloaded<TTable extends TableDefinition>(
  owner: HyperDB,
  getPrimary: () => Generator<DBCmd, HyperDB>,
  data: PreloadedHybridData,
  table: TTable,
  indexName: keyof ExtractIndexes<TTable>,
  clauses: WhereClause[],
  selectOptions?: SelectOptions,
): Generator<DBCmd, ExtractSchema<TTable>[]> {
  const tableState = data.get(table);
  const limit = selectOptions?.limit;
  if (limit !== undefined && limit <= 0) return [];

  const scansById = String(indexName) === table.idIndexName;
  let ids: string[];
  if (scansById) {
    const seen = new Set<string>();
    ids = hashScanValues("id", clauses).flatMap((value) => {
      if (typeof value !== "string") {
        throw new Error("Primary-key index byId requires string IDs");
      }
      if (seen.has(value)) return [];
      seen.add(value);
      return [value];
    });
  } else {
    ids = tableState.indexes.scan(String(indexName), clauses, selectOptions);
  }
  if (limit !== undefined) ids = ids.slice(0, limit);

  const missingIds = ids.filter((id) => {
    const entry = entityById(tableState.byId, id);
    return entry === undefined
      ? !usesExternalStorageMerge(owner)
      : !entry.loaded;
  });
  const selectEvent = getCurrentSelectEventForDB(owner);

  if (selectEvent) {
    selectEvent.source = missingIds.length === 0 ? "in-mem" : "persist";
  }

  if (missingIds.length > 0) {
    const primary = yield* getPrimary();
    const loadedRows: Row[] = [];
    for (const batch of chunks(missingIds, entityLoadBatchSize)) {
      loadedRows.push(
        ...(yield* primary.intervalScan(
          table,
          table.idIndexName,
          batch.map((id) => ({ eq: [{ col: "id", val: id }] })),
        )),
      );
    }

    tableState.indexes.upsert(loadedRows);
    tableState.byId.upsert(loadedEntities(loadedRows));
    const loadedIds = new Set(loadedRows.map((row) => row.id));
    const staleIds = missingIds.filter((id) => !loadedIds.has(id));
    if (staleIds.length > 0) {
      tableState.indexes.delete(staleIds);
      tableState.byId.delete(staleIds);
    }
  }

  const rows = ids.flatMap((id) => {
    const entry = entityById(tableState.byId, id);
    return entry?.loaded && entry.row
      ? [entry.row as ExtractSchema<TTable>]
      : [];
  });
  return rows;
}

/**
 * A persistent/in-memory runtime that preloads every table index as
 * key-to-entity-id entries while loading entity rows only when a scan needs
 * them. Hydrated rows are retained in a unique id cache and shared by every
 * index.
 */
export class PreloadedHybridDB implements HyperDB {
  readonly primary: DB;
  traits: Trait[];
  private readonly preloadConcurrency: number | "whole";
  private state: PreloadedHybridDBState;

  constructor(primary: DB, options: PreloadedHybridDBOptions = {}) {
    this.primary = primary;
    this.traits = options.traits ?? [];
    this.preloadConcurrency = normalizePreloadConcurrency(
      options.preloadConcurrency,
    );
    this.state = createState();
  }

  withTraits<TTrait extends Trait>(...traits: TTrait[]): HyperDB {
    const db = new PreloadedHybridDB(this.primary, {
      traits: [...this.traits, ...traits],
      preloadConcurrency: this.preloadConcurrency,
    });
    db.state = this.state;
    return db;
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.primary.getTraits()];
  }

  getId(): string {
    return this.primary.getId();
  }

  getDBName(): string | undefined {
    return this.primary.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.primary.getTracer?.();
  }

  getOptions(): CodecOptions {
    return this.primary.getOptions?.() ?? DEFAULT_CODEC_OPTIONS;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return this.primary.canUseReadonlyTransactionsForSelectors();
  }

  private delegatePrimary(): HyperDB {
    return this.traits.length > 0
      ? this.primary.withTraits(...this.traits)
      : this.primary;
  }

  *loadTables(tables: TableDefinition[]): Generator<DBCmd, void> {
    const release = yield* acquireLock(this.state.lock);
    try {
      yield* this.waitForPersistence();
      yield* this.delegatePrimary().loadTables(tables);
      const data = this.state.data;
      const concurrency =
        this.preloadConcurrency === "whole"
          ? tables.length
          : Math.min(this.preloadConcurrency, tables.length);

      if (concurrency <= 1) {
        let hasError = false;
        let firstError: unknown;
        for (const table of tables) {
          try {
            const rows = yield* this.primary.scanAll(table);
            data.tables.set(
              table.tableName,
              createPreloadedTableState(table, rows as Row[]),
            );
          } catch (error) {
            if (!hasError) firstError = error;
            hasError = true;
          }
        }
        if (hasError) throw firstError;
        return;
      }

      const results = yield* unwrap(
        preloadTablesConcurrently(this.primary, tables, concurrency),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          data.tables.set(result.table.tableName, result.state);
        }
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    } finally {
      release();
    }
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    for (const spec of specs) this.state.data.get(spec.table);
  }

  *intervalScan<
    TTable extends TableDefinition,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Generator<DBCmd, ExtractSchema<TTable>[]> {
    this.throwIfCrashed();
    const release = yield* acquireLock(this.state.lock);
    try {
      this.throwIfCrashed();
      return yield* scanPreloaded(
        this,
        this.primaryForRead.bind(this),
        this.state.data,
        table,
        indexName,
        clauses,
        selectOptions,
      );
    } finally {
      release();
    }
  }

  private *primaryForRead(): Generator<DBCmd, HyperDB> {
    yield* this.waitForPersistence();
    return withDriverTraceContextTrait(
      this.delegatePrimary(),
      getDriverTraceContextForDB(this),
    );
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    const tx = yield* this.beginTx();
    try {
      yield* tx.insert(table, records);
      yield* tx.commit();
    } catch (error) {
      yield* tx.rollback();
      throw error;
    }
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    const tx = yield* this.beginTx();
    try {
      yield* tx.upsert(table, records);
      yield* tx.commit();
    } catch (error) {
      yield* tx.rollback();
      throw error;
    }
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    const tx = yield* this.beginTx();
    try {
      yield* tx.delete(table, ids);
      yield* tx.commit();
    } catch (error) {
      yield* tx.rollback();
      throw error;
    }
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, HyperDBTx> {
    this.throwIfCrashed();
    const release = yield* acquireLock(this.state.lock);
    try {
      this.throwIfCrashed();
      const data =
        mode === "readonly" ? this.state.data : this.state.data.fork();
      return new PreloadedHybridDBTx(this, data, mode, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  get isCrashed(): boolean {
    return this.state.persistence.isCrashed;
  }

  throwIfCrashed(): void {
    this.state.persistence.throwIfCrashed();
  }

  *waitForPersistence(): Generator<DBCmd, void> {
    yield* this.state.persistence.waitForPersistence();
  }

  get isClosed(): boolean {
    const { persistence } = this.state;
    return persistence.isClosing || persistence.isClosed;
  }

  *close(): Generator<DBCmd, void> {
    const { persistence } = this.state;
    if (persistence.isClosed) return;
    // Refuse new commits first; commits that passed the gate enqueue
    // synchronously, so settle() drains them before the primary closes.
    persistence.isClosing = true;
    yield* persistence.settle();
    yield* this.primary.close();
    // Every operation now fails with DB_CLOSED, so release the preloaded
    // indexes and rows; withTraits() views share this state.
    this.state.data = new PreloadedHybridData();
    persistence.isClosed = true;
  }

  enqueuePersistence(writes: HybridPendingWrite[], primary: HyperDB): void {
    this.state.persistence.enqueue(primary, writes);
  }

  throwIfPersistenceFull(writes: HybridPendingWrite[]): void {
    this.state.persistence.throwIfFull(writes);
  }

  commitData(data: PreloadedHybridData): void {
    data.materializeFork();
    this.state.data = data;
  }
}

type PreloadedHybridTxState = {
  committed: RefVar<boolean>;
  rollbacked: RefVar<boolean>;
  counter: RefVar<number>;
  release: () => void;
  primaryTx?: HyperDBTx;
  writes: HybridPendingWrite[];
};

class PreloadedHybridDBTx implements HyperDBTx {
  private readonly state: PreloadedHybridTxState;
  private readonly owner: PreloadedHybridDB;
  private readonly data: PreloadedHybridData;
  private readonly mode: DBTransactionMode;
  private readonly traits: Trait[];

  constructor(
    owner: PreloadedHybridDB,
    data: PreloadedHybridData,
    mode: DBTransactionMode,
    release: () => void,
    traits: Trait[] = [],
    state?: PreloadedHybridTxState,
  ) {
    this.owner = owner;
    this.data = data;
    this.mode = mode;
    this.traits = traits;
    this.state = state ?? {
      committed: refVar(false),
      rollbacked: refVar(false),
      counter: refVar(1),
      release,
      writes: [],
    };
  }

  withTraits<TTrait extends Trait>(...traits: TTrait[]): HyperDBTx {
    return new PreloadedHybridDBTx(
      this.owner,
      this.data,
      this.mode,
      this.state.release,
      [...this.traits, ...traits],
      this.state,
    );
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.owner.getTraits()];
  }

  getId(): string {
    return this.owner.getId();
  }

  getDBName(): string | undefined {
    return this.owner.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.owner.getTracer?.();
  }

  getOptions(): CodecOptions {
    return this.owner.getOptions();
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  private delegatePrimary(): HyperDB {
    const traits = [...this.owner.traits, ...this.traits];
    const primary =
      traits.length > 0
        ? this.owner.primary.withTraits(...traits)
        : this.owner.primary;
    return withDriverTraceContextTrait(
      primary,
      getDriverTraceContextForDB(this),
    );
  }

  private *primaryForRead(): Generator<DBCmd, HyperDB> {
    if (!this.state.primaryTx) {
      yield* this.owner.waitForPersistence();
      this.state.primaryTx = yield* this.delegatePrimary().beginTx("readonly");
    }
    return this.traits.length > 0
      ? this.state.primaryTx.withTraits(...this.traits)
      : this.state.primaryTx;
  }

  *loadTables(): Generator<DBCmd, void> {
    throw new Error("Not supported");
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    _specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    throw new Error(
      "preloadTables is not supported inside PreloadedHybridDB transactions",
    );
  }

  *beginTx(): Generator<DBCmd, HyperDBTx> {
    this.throwIfDone();
    this.state.counter.val++;
    return this;
  }

  *intervalScan<
    TTable extends TableDefinition,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Generator<DBCmd, ExtractSchema<TTable>[]> {
    this.throwIfDone();
    return yield* scanPreloaded(
      this,
      this.primaryForRead.bind(this),
      this.data,
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    if (!usesExternalStorageMerge(this)) {
      const state = this.data.get(table);
      const ids = new Set<string>();
      for (const row of records) {
        const entry = entityById(state.byId, row.id);
        if (
          ids.has(row.id) ||
          (entry && (!entry.loaded || entry.row !== null))
        ) {
          throw new DuplicateIdError(row.id);
        }
        ids.add(row.id);
      }
    }
    yield* this.writeRows(table, records, !usesExternalStorageMerge(this));
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    yield* this.writeRows(table, records, false);
  }

  private *writeRows<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
    insertOnly: boolean,
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    const options = this.getOptions();
    const normalized = normalizeRecordsForDriver(table, records, options);
    const state = this.data.get(table);
    state.indexes.upsert(normalized);
    state.byId.upsert(loadedEntities(normalized));
    for (const row of normalized) {
      this.state.writes.push({
        table,
        id: row.id,
        newValue: row,
        insertOnly,
        oldValueKnown: false,
      });
    }
    if (options.freezeRows) {
      deepFreeze(records);
      deepFreeze(normalized);
    }
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    const state = this.data.get(table);
    state.indexes.delete(ids);
    state.byId.upsert(
      ids.map((id) => ({
        key: id,
        id,
        value: { id, loaded: true, row: null },
      })),
    );
    for (const id of ids)
      this.state.writes.push({ table, id, oldValueKnown: false });
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.state.counter.val--;
    if (this.state.counter.val > 0) return;

    try {
      if (this.state.primaryTx) yield* this.state.primaryTx.commit();
      this.owner.throwIfCrashed();
      if (this.mode === "readwrite") {
        this.owner.throwIfPersistenceFull(this.state.writes);
        this.owner.commitData(this.data);
        this.owner.enqueuePersistence(
          this.state.writes,
          this.delegatePrimary(),
        );
      }
      this.state.committed.val = true;
    } catch (error) {
      if (this.mode === "readwrite") this.data.discardFork();
      this.state.rollbacked.val = true;
      throw error;
    } finally {
      this.state.release();
    }
  }

  *rollback(): Generator<DBCmd, void> {
    if (this.state.rollbacked.val) return;
    if (this.state.committed.val)
      throw new HyperDBError(
        "TRANSACTION_FINISHED",
        "Transaction already finished",
      );
    let rollbackFailed = false;
    let rollbackError: unknown;
    try {
      if (this.state.primaryTx) yield* this.state.primaryTx.rollback();
    } catch (error) {
      rollbackFailed = true;
      rollbackError = error;
    } finally {
      if (this.mode === "readwrite") this.data.discardFork();
      this.state.rollbacked.val = true;
      this.state.release();
    }
    if (rollbackFailed) throw rollbackError;
  }

  private throwIfDone(): void {
    this.owner.throwIfCrashed();
    if (this.state.committed.val || this.state.rollbacked.val) {
      throw new HyperDBError(
        "TRANSACTION_FINISHED",
        "Transaction already finished",
      );
    }
  }

  private throwIfReadonly(): void {
    if (this.mode === "readonly") {
      throw new HyperDBError(
        "READONLY_TRANSACTION",
        "Cannot write through a readonly transaction",
      );
    }
  }
}
