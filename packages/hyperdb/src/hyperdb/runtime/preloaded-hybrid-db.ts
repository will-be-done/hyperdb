import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
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
  TableDefinition,
} from "../schema/table";
import { DEFAULT_CODEC_OPTIONS, type CodecOptions } from "../storage/codec";
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

const entityLoadBatchSize = 500;

type EntityEntry =
  | { id: string; loaded: false }
  | { id: string; loaded: true; row: Row };

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
    if (!state) throw new Error(`Table ${table.tableName} not found`);
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
};

const createState = (): PreloadedHybridDBState => ({
  data: new PreloadedHybridData(),
  lock: new AwaitLock(),
});

export type PreloadedHybridDBOptions = {
  traits?: Trait[];
};

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
  primary: HyperDB,
  data: PreloadedHybridData,
  table: TTable,
  indexName: keyof ExtractIndexes<TTable>,
  clauses: WhereClause[],
  selectOptions?: SelectOptions,
): Generator<DBCmd, ExtractSchema<TTable>[]> {
  const tableState = data.get(table);
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
  const missingIds = ids.filter((id) => {
    const entry = entityById(tableState.byId, id);
    return entry === undefined || !entry.loaded;
  });
  const selectEvent = getCurrentSelectEventForDB(owner);

  if (selectEvent) {
    selectEvent.source = missingIds.length === 0 ? "in-mem" : "persist";
  }

  if (missingIds.length > 0) {
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
    return entry?.loaded ? [entry.row as ExtractSchema<TTable>] : [];
  });
  return selectOptions?.limit === undefined
    ? rows
    : rows.slice(0, Math.max(0, selectOptions.limit));
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
  private state: PreloadedHybridDBState;

  constructor(primary: DB, options: PreloadedHybridDBOptions = {}) {
    this.primary = primary;
    this.traits = options.traits ?? [];
    this.state = createState();
  }

  withTraits(...traits: Trait[]): HyperDB {
    const db = new PreloadedHybridDB(this.primary, {
      traits: [...this.traits, ...traits],
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
      yield* this.delegatePrimary().loadTables(tables);
      const data = new PreloadedHybridData();
      for (const table of tables) {
        const rows = yield* this.primary.scanAll(table);
        const byId = new HashIndex<EntityEntry>({
          name: table.idIndexName,
          unique: true,
        });
        byId.insert(entityPointers(rows));
        data.tables.set(table.tableName, {
          indexes: new PreloadedTableIndexes(table, rows as Row[]),
          byId,
        });
      }
      this.state.data = data;
    } finally {
      release();
    }
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
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
    const release = yield* acquireLock(this.state.lock);
    try {
      const primary = withDriverTraceContextTrait(
        this.delegatePrimary(),
        getDriverTraceContextForDB(this),
      );
      return yield* scanPreloaded(
        this,
        primary,
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

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    const release = yield* acquireLock(this.state.lock);
    try {
      yield* this.delegatePrimary().insert(table, records);
      const state = this.state.data.get(table);
      state.indexes.upsert(records as Row[]);
      state.byId.upsert(loadedEntities(records as Row[]));
    } finally {
      release();
    }
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    const release = yield* acquireLock(this.state.lock);
    try {
      yield* this.delegatePrimary().upsert(table, records);
      const state = this.state.data.get(table);
      state.indexes.upsert(records as Row[]);
      state.byId.upsert(loadedEntities(records as Row[]));
    } finally {
      release();
    }
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    const release = yield* acquireLock(this.state.lock);
    try {
      yield* this.delegatePrimary().delete(table, ids);
      const state = this.state.data.get(table);
      state.indexes.delete(ids);
      state.byId.delete(ids);
    } finally {
      release();
    }
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, HyperDBTx> {
    const release = yield* acquireLock(this.state.lock);
    try {
      const primary = withDriverTraceContextTrait(
        this.delegatePrimary(),
        getDriverTraceContextForDB(this),
      );
      const primaryTx = yield* primary.beginTx(mode);
      const data =
        mode === "readonly" ? this.state.data : this.state.data.fork();
      return new PreloadedHybridDBTx(this, primaryTx, data, mode, release);
    } catch (error) {
      release();
      throw error;
    }
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
};

class PreloadedHybridDBTx implements HyperDBTx {
  private readonly state: PreloadedHybridTxState;
  private readonly owner: PreloadedHybridDB;
  private readonly primaryTx: HyperDBTx;
  private readonly data: PreloadedHybridData;
  private readonly mode: DBTransactionMode;
  private readonly traits: Trait[];

  constructor(
    owner: PreloadedHybridDB,
    primaryTx: HyperDBTx,
    data: PreloadedHybridData,
    mode: DBTransactionMode,
    release: () => void,
    traits: Trait[] = [],
    state?: PreloadedHybridTxState,
  ) {
    this.owner = owner;
    this.primaryTx = primaryTx;
    this.data = data;
    this.mode = mode;
    this.traits = traits;
    this.state = state ?? {
      committed: refVar(false),
      rollbacked: refVar(false),
      counter: refVar(1),
      release,
    };
  }

  withTraits(...traits: Trait[]): HyperDBTx {
    return new PreloadedHybridDBTx(
      this.owner,
      this.primaryTx,
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

  private delegatePrimary(): HyperDBTx {
    return this.traits.length > 0
      ? (this.primaryTx.withTraits(...this.traits) as HyperDBTx)
      : this.primaryTx;
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
      this.delegatePrimary(),
      this.data,
      table,
      indexName,
      clauses,
      selectOptions,
    );
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    yield* this.delegatePrimary().insert(table, records);
    const state = this.data.get(table);
    state.indexes.upsert(records as Row[]);
    state.byId.upsert(loadedEntities(records as Row[]));
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    yield* this.delegatePrimary().upsert(table, records);
    const state = this.data.get(table);
    state.indexes.upsert(records as Row[]);
    state.byId.upsert(loadedEntities(records as Row[]));
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.throwIfReadonly();
    yield* this.delegatePrimary().delete(table, ids);
    const state = this.data.get(table);
    state.indexes.delete(ids);
    state.byId.delete(ids);
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.state.counter.val--;
    if (this.state.counter.val > 0) return;

    try {
      yield* this.delegatePrimary().commit();
      if (this.mode === "readwrite") this.owner.commitData(this.data);
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
    this.throwIfDone();
    let rollbackFailed = false;
    let rollbackError: unknown;
    try {
      yield* this.delegatePrimary().rollback();
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
    if (this.state.committed.val || this.state.rollbacked.val) {
      throw new Error("Transaction already finished");
    }
  }

  private throwIfReadonly(): void {
    if (this.mode === "readonly") {
      throw new Error("Cannot write through a readonly transaction");
    }
  }
}
