import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
import type {
  HyperDB,
  HyperDBTx,
  HybridPreloadTableSpecInput,
  ValidateHybridPreloadTableSpecs,
} from "../core/contracts";
import {
  type Row,
  type SelectOptions,
  type Trait,
  type WhereClause,
} from "../core/primitives";
import {
  getCurrentSelectEventForDB,
  getDriverTraceContextForDB,
  type HyperDBTracerOption,
  withDriverTraceContextTrait,
} from "../core/tracer";
import type { DBTransactionMode } from "../core/driver";
import { DEFAULT_CODEC_OPTIONS, type CodecOptions } from "../storage/codec";
import type {
  ExtractIndexes,
  ExtractSchema,
  TableDefinition,
} from "../schema/table";
import AwaitLock from "../utils/await-lock";
import { refVar, type RefVar } from "../utils";
import { cloneDeep } from "../utils/toolkit";
import { deepFreeze } from "../deep-freeze";
import {
  createHybridIntervalCache,
  hybridIntervalScan,
  intervalFromClauses,
  mergeCoverage,
  mergeExactUniqhashCoverage,
  mergeExactUniqhashCoverageForRows,
  mergeCoverageMaps,
  rowMatchesIntervalTarget,
  type HybridIntervalCache,
  type HybridPersistentScanDebugInfo,
  type IntervalTarget,
  type NormalizedInterval,
} from "./hybrid-db-intervals";
import {
  coalescePersistenceWrites,
  HybridPersistenceQueue,
  type HybridPendingWrite,
  type HybridPersistenceFailure,
} from "./hybrid-persistence";
import { HyperDBError } from "../core/errors";
export { HybridDBCrashedError } from "./hybrid-persistence";

type HybridDBState = {
  cachedIntervals: HybridIntervalCache;
  lock: AwaitLock;
  persistence: HybridPersistenceQueue;
};

type HybridDBTxState = {
  cachedIntervals: HybridIntervalCache;
  pendingWrites: HybridPendingWrite[];
  committed: RefVar<boolean>;
  rollbacked: RefVar<boolean>;
  txCounter: RefVar<number>;
  releaseLock: () => void;
};

type HybridReadonlyTxState = {
  primaryTx?: HyperDBTx;
  rollbacked: RefVar<boolean>;
  txCounter: RefVar<number>;
};

export type HybridDBPendingPersistenceWaitReason = {
  batchId: number;
  tableName: string;
  rowId: string;
  oldValueKnown: boolean;
  oldValueMatches: boolean;
  newValueMatches: boolean;
};

export type HybridDBPendingPersistenceWaitDebugEvent = {
  type: "pending-persistence-wait";
  tableName: string;
  indexName: string;
  clauses: WhereClause[];
  selectOptions?: SelectOptions;
  reasons: HybridDBPendingPersistenceWaitReason[];
};

export type HybridDBPersistentScanDebugEvent = {
  type: "persistent-scan";
  scope: "root" | "readonly-tx" | "readwrite-tx";
  tableName: string;
  indexName: string;
  clauses: WhereClause[];
  selectOptions?: SelectOptions;
  targetKey: string;
  indexCols: string[];
  targetIntervals: NormalizedInterval[];
  cachedIntervals: NormalizedInterval[];
  uncoveredIntervals: NormalizedInterval[];
  limitedCacheProbe?: HybridPersistentScanDebugInfo["limitedCacheProbe"];
};

export type HybridDBPersistenceFailureDebugEvent = {
  type: "persistence-failure";
  batchId: number;
  writeCount: number;
  error: unknown;
  attempt: number;
  maxAttempts: number;
  retryDelayMs?: number;
  willRetry: boolean;
};

export type HybridDBDebugEvent =
  | HybridDBPendingPersistenceWaitDebugEvent
  | HybridDBPersistentScanDebugEvent
  | HybridDBPersistenceFailureDebugEvent;

const createHybridDBState = (): HybridDBState => ({
  cachedIntervals: createHybridIntervalCache(),
  lock: new AwaitLock(),
  persistence: new HybridPersistenceQueue(),
});

const createHybridDBTxState = (releaseLock: () => void): HybridDBTxState => ({
  cachedIntervals: createHybridIntervalCache(),
  pendingWrites: [],
  committed: refVar(false),
  rollbacked: refVar(false),
  txCounter: refVar(1),
  releaseLock,
});

const createHybridReadonlyTxState = (): HybridReadonlyTxState => ({
  rollbacked: refVar(false),
  txCounter: refVar(1),
});

export type HybridDBOptions = {
  traits?: Trait[];
  debug?: boolean | ((event: HybridDBDebugEvent) => void);
};

function* acquireHybridLock(
  state: HybridDBState,
): Generator<DBCmd, () => void> {
  if (!state.lock.tryAcquire()) {
    yield* unwrap(state.lock.acquireAsync());
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.lock.release();
  };
}

function* withHybridLock<T>(
  state: HybridDBState,
  run: () => Generator<DBCmd, T>,
): Generator<DBCmd, T> {
  const release = yield* acquireHybridLock(state);
  try {
    return yield* run();
  } finally {
    release();
  }
}

function pendingWriteMatchReason(
  write: HybridPendingWrite,
  batchId: number,
  table: TableDefinition,
  target: IntervalTarget,
): HybridDBPendingPersistenceWaitReason | undefined {
  if (write.table !== table) return undefined;
  const oldValueMatches =
    write.oldValue !== undefined &&
    rowMatchesIntervalTarget(write.oldValue, target);
  const newValueMatches =
    write.newValue !== undefined &&
    rowMatchesIntervalTarget(write.newValue, target);
  if (write.oldValueKnown && !oldValueMatches && !newValueMatches) {
    return undefined;
  }

  return {
    batchId,
    tableName: table.tableName,
    rowId: write.id,
    oldValueKnown: write.oldValueKnown,
    oldValueMatches,
    newValueMatches,
  };
}

function pendingWritesMatchTarget(
  writes: Iterable<HybridPendingWrite>,
  table: TableDefinition,
  target: IntervalTarget,
): boolean {
  for (const write of writes) {
    if (pendingWriteMatchReason(write, 0, table, target)) return true;
  }
  return false;
}

function mergeExactUniqhashWriteCoverage(
  cachedIntervals: HybridIntervalCache,
  writes: HybridPendingWrite[],
): void {
  for (const write of coalescePersistenceWrites(writes)) {
    for (const [indexName, indexConfig] of Object.entries(
      write.table.indexes,
    )) {
      if (
        indexConfig.type === "uniqhash" &&
        indexConfig.cols.length === 1 &&
        indexConfig.cols[0] === "id"
      ) {
        mergeExactUniqhashCoverage(
          cachedIntervals,
          `${write.table.tableName}:${indexName}`,
          write.id,
        );
      }
    }

    const rows: Row[] = [];
    if (write.newValue) {
      rows.push(write.newValue);
    }
    if (write.oldValueKnown && write.oldValue) {
      rows.push(write.oldValue);
    }
    mergeExactUniqhashCoverageForRows(cachedIntervals, write.table, rows);
  }
}

export class HybridDB implements HyperDB {
  primary: HyperDB;
  cache: HyperDB;
  traits: Trait[] = [];
  debug: HybridDBOptions["debug"];
  state: HybridDBState;

  constructor(primary: HyperDB, cache: HyperDB, options: HybridDBOptions = {}) {
    this.primary = primary;
    this.cache = cache;
    this.traits = options.traits ?? [];
    this.debug = options.debug;
    this.state = createHybridDBState();
  }

  withTraits(...traits: Trait[]): HyperDB {
    const db = new HybridDB(this.primary, this.cache, {
      traits: [...this.traits, ...traits],
      debug: this.debug,
    });
    db.state = this.state;
    return db;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return this.primary.canUseReadonlyTransactionsForSelectors();
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

  *loadTables(tables: TableDefinition[]): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const { cache, primary, state } = this;
    yield* this.waitForPendingPersistence();
    yield* withHybridLock(this.state, function* () {
      yield* primary.loadTables(tables);
      yield* cache.loadTables(tables);
      state.cachedIntervals.clear();
    });
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const { cache, primary, state } = this;
    const traceContext = getDriverTraceContextForDB(this);

    yield* this.waitForPendingPersistence();
    yield* withHybridLock(state, function* () {
      for (const spec of specs) {
        const table = spec.table;
        const scanIndex = String(spec.scanIndex);
        const scanIndexConfig = table.indexes[scanIndex];
        if (!scanIndexConfig) {
          throw new HyperDBError(
            "INDEX_NOT_FOUND",
            `Index not found: ${scanIndex} for table: ${table.tableName}`,
          );
        }
        if (scanIndexConfig.type !== "btree") {
          throw new Error(
            `HybridDB preload scan index must be a btree index: ${scanIndex} for table: ${table.tableName}`,
          );
        }

        const rows = yield* withDriverTraceContextTrait(
          primary,
          traceContext,
        ).intervalScan(table, scanIndex, [{}]);

        if (rows.length > 0) {
          yield* withDriverTraceContextTrait(cache, traceContext).upsert(
            table,
            rows,
          );
        }

        for (const indexName of spec.coverageIndexes ??
          Object.keys(table.indexes)) {
          const target = intervalFromClauses(table, String(indexName), [{}]);
          mergeCoverage(state.cachedIntervals, target.key, target.intervals);
        }
      }
    });
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, HyperDBTx> {
    this.throwIfCrashed();
    if (mode === "readonly") {
      return new HybridDBReadonlyTx(this);
    }

    const release = yield* acquireHybridLock(this.state);
    const cache = withDriverTraceContextTrait(
      this.cache,
      getDriverTraceContextForDB(this),
    );
    try {
      const cacheTx = yield* cache.beginTx("readwrite");
      return new HybridDBTx(this, cacheTx, release);
    } catch (error) {
      release();
      throw error;
    }
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
    const { cache, primary, state } = this;
    const selectEvent = getCurrentSelectEventForDB(this);
    const traceContext = getDriverTraceContextForDB(this);
    const emitPersistentScanDebugEvent =
      this.emitPersistentScanDebugEvent.bind(this);
    const waitForPendingPersistenceForScan =
      this.waitForPendingPersistenceForScan.bind(this);
    return yield* withHybridLock(this.state, function* () {
      return yield* hybridIntervalScan(
        withDriverTraceContextTrait(primary, traceContext),
        withDriverTraceContextTrait(cache, traceContext),
        state.cachedIntervals,
        selectEvent,
        table,
        indexName,
        clauses,
        selectOptions,
        {
          onPersistentScan: (info) => {
            emitPersistentScanDebugEvent(
              "root",
              table,
              indexName,
              clauses,
              selectOptions,
              info,
            );
          },
          beforePersistentScan: function* (target: IntervalTarget) {
            yield* waitForPendingPersistenceForScan(
              table,
              indexName,
              clauses,
              selectOptions,
              target,
            );
          },
        },
      );
    });
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
    yield* this.waitForPendingPersistence();
    yield* withHybridLock(this.state, function* () {
      yield* withDriverTraceContextTrait(primary, traceContext).insert(
        table,
        records,
      );
      yield* withDriverTraceContextTrait(cache, traceContext).insert(
        table,
        records,
      );
    });
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
    yield* this.waitForPendingPersistence();
    yield* withHybridLock(this.state, function* () {
      yield* withDriverTraceContextTrait(primary, traceContext).upsert(
        table,
        records,
      );
      yield* withDriverTraceContextTrait(cache, traceContext).upsert(
        table,
        records,
      );
    });
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
    yield* this.waitForPendingPersistence();
    yield* withHybridLock(this.state, function* () {
      yield* withDriverTraceContextTrait(primary, traceContext).delete(
        table,
        ids,
      );
      yield* withDriverTraceContextTrait(cache, traceContext).delete(
        table,
        ids,
      );
    });
  }

  mergeTxCoverage(intervals: HybridIntervalCache): void {
    mergeCoverageMaps(this.state.cachedIntervals, intervals);
  }

  get isCrashed(): boolean {
    return this.state.persistence.isCrashed;
  }

  throwIfCrashed(): void {
    this.state.persistence.throwIfCrashed();
  }

  throwIfPersistenceFull(writes: HybridPendingWrite[]): void {
    this.state.persistence.throwIfFull(writes);
  }

  enqueuePersistence(
    writes: HybridPendingWrite[],
    traceContext: ReturnType<typeof getDriverTraceContextForDB>,
  ): void {
    this.state.persistence.enqueue(
      withDriverTraceContextTrait(this.primary, traceContext),
      writes,
      (batchId, failure) =>
        this.emitPersistenceFailureDebugEvent(batchId, writes, failure),
    );
  }

  *waitForPersistence(): Generator<DBCmd, void> {
    yield* this.state.persistence.waitForPersistence();
  }

  *close(): Generator<DBCmd, void> {
    const { persistence } = this.state;
    if (persistence.isClosed) return;
    yield* persistence.settle();
    persistence.isClosed = true;
    if (this.primary.close) yield* this.primary.close();
    if (this.cache.close) yield* this.cache.close();
  }

  *waitForPendingPersistence(): Generator<DBCmd, void> {
    yield* this.waitForPersistence();
  }

  *waitForPendingPersistenceForScan(
    table: TableDefinition,
    indexName: string | number | symbol,
    clauses: WhereClause[],
    selectOptions: SelectOptions | undefined,
    target: IntervalTarget,
  ): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const pending: Promise<void>[] = [];
    const reasons: HybridDBPendingPersistenceWaitReason[] = [];

    for (const batch of this.state.persistence.pending) {
      const batchReasons = batch.writes.flatMap((write) => {
        const reason = pendingWriteMatchReason(write, batch.id, table, target);
        return reason ? [reason] : [];
      });
      if (batchReasons.length === 0) continue;

      pending.push(batch.promise);
      reasons.push(...batchReasons);
    }

    if (pending.length > 0) {
      this.emitDebugEvent({
        type: "pending-persistence-wait",
        tableName: table.tableName,
        indexName: String(indexName),
        clauses,
        selectOptions,
        reasons,
      });
      yield* unwrap(Promise.allSettled(pending).then(() => undefined));
    }
    this.throwIfCrashed();
  }

  private emitDebugEvent(event: HybridDBDebugEvent): void {
    if (!this.debug) return;

    if (typeof this.debug === "function") {
      this.debug(event);
      return;
    }

    if (event.type === "pending-persistence-wait") {
      console.debug("HybridDB pending persistence wait", {
        tableName: event.tableName,
        indexName: event.indexName,
        reasonCount: event.reasons.length,
        reasons: event.reasons,
      });
      return;
    }

    if (event.type === "persistence-failure") {
      console.debug("HybridDB persistence failure", {
        batchId: event.batchId,
        writeCount: event.writeCount,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        retryDelayMs: event.retryDelayMs,
        willRetry: event.willRetry,
        error: event.error,
      });
      return;
    }

    console.debug("HybridDB persistent scan", {
      scope: event.scope,
      tableName: event.tableName,
      indexName: event.indexName,
      targetKey: event.targetKey,
      targetIntervals: event.targetIntervals,
      cachedIntervals: event.cachedIntervals,
      uncoveredIntervals: event.uncoveredIntervals,
      limitedCacheProbe: event.limitedCacheProbe,
    });
  }

  private emitPersistenceFailureDebugEvent(
    batchId: number,
    writes: HybridPendingWrite[],
    failure: HybridPersistenceFailure,
  ): void {
    this.emitDebugEvent({
      type: "persistence-failure",
      batchId,
      writeCount: writes.length,
      ...failure,
    });
  }

  emitPersistentScanDebugEvent(
    scope: HybridDBPersistentScanDebugEvent["scope"],
    table: TableDefinition,
    indexName: string | number | symbol,
    clauses: WhereClause[],
    selectOptions: SelectOptions | undefined,
    info: HybridPersistentScanDebugInfo,
  ): void {
    this.emitDebugEvent({
      type: "persistent-scan",
      scope,
      tableName: table.tableName,
      indexName: String(indexName),
      clauses,
      selectOptions,
      targetKey: info.target.key,
      indexCols: info.target.indexCols,
      targetIntervals: info.target.intervals,
      cachedIntervals: info.cached,
      uncoveredIntervals: info.uncovered,
      limitedCacheProbe: info.limitedCacheProbe,
    });
  }
}

class HybridDBReadonlyTx implements HyperDBTx {
  private hybridDB: HybridDB;
  private state: HybridReadonlyTxState;
  private traits: Trait[];

  constructor(
    hybridDB: HybridDB,
    state: HybridReadonlyTxState = createHybridReadonlyTxState(),
    traits: Trait[] = [],
  ) {
    this.hybridDB = hybridDB;
    this.state = state;
    this.traits = traits;
  }

  withTraits(...traits: Trait[]): HyperDBTx {
    return new HybridDBReadonlyTx(this.hybridDB, this.state, [
      ...this.traits,
      ...traits,
    ]);
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.hybridDB.getTraits()];
  }

  getId(): string {
    return this.hybridDB.getId();
  }

  getDBName(): string | undefined {
    return this.hybridDB.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.hybridDB.getTracer?.();
  }

  getOptions(): CodecOptions {
    return this.hybridDB.getOptions?.() ?? DEFAULT_CODEC_OPTIONS;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *loadTables(): Generator<DBCmd, void> {
    throw new Error("Not supported");
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    _specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    throw new Error(
      "preloadTables is not supported inside HybridDB transactions",
    );
  }

  *beginTx(
    _mode: DBTransactionMode = "readwrite",
  ): Generator<DBCmd, HyperDBTx> {
    this.throwIfDone();
    this.hybridDB.throwIfCrashed();
    this.state.txCounter.val++;
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
    this.hybridDB.throwIfCrashed();
    const { hybridDB } = this;
    const { cache, state } = hybridDB;
    const selectEvent = getCurrentSelectEventForDB(this);
    const traceContext = getDriverTraceContextForDB(this);
    const getPrimaryForRead = function* (
      this: HybridDBReadonlyTx,
    ): Generator<DBCmd, HyperDB> {
      if (this.state.primaryTx) {
        return withDriverTraceContextTrait(this.state.primaryTx, traceContext);
      }

      const { primary } = this.hybridDB;
      const tracePrimary = withDriverTraceContextTrait(primary, traceContext);
      const tx = tracePrimary.canUseReadonlyTransactionsForSelectors()
        ? yield* tracePrimary.beginTx("readonly")
        : undefined;

      this.state.primaryTx = tx;
      return tx ?? tracePrimary;
    }.bind(this);

    return yield* withHybridLock(state, function* () {
      return yield* hybridIntervalScan(
        getPrimaryForRead,
        withDriverTraceContextTrait(cache, traceContext),
        state.cachedIntervals,
        selectEvent,
        table,
        indexName,
        clauses,
        selectOptions,
        {
          onPersistentScan: (info) => {
            hybridDB.emitPersistentScanDebugEvent(
              "readonly-tx",
              table,
              indexName,
              clauses,
              selectOptions,
              info,
            );
          },
          beforePersistentScan: function* (target: IntervalTarget) {
            yield* hybridDB.waitForPendingPersistenceForScan(
              table,
              indexName,
              clauses,
              selectOptions,
              target,
            );
          },
        },
      );
    });
  }

  *insert<TTable extends TableDefinition>(
    _table: TTable,
    _records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    throw new HyperDBError(
      "READONLY_TRANSACTION",
      "Cannot write through a readonly transaction",
    );
  }

  *upsert<TTable extends TableDefinition>(
    _table: TTable,
    _records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    throw new HyperDBError(
      "READONLY_TRANSACTION",
      "Cannot write through a readonly transaction",
    );
  }

  *delete<TTable extends TableDefinition>(
    _table: TTable,
    _ids: string[],
  ): Generator<DBCmd, void> {
    throw new HyperDBError(
      "READONLY_TRANSACTION",
      "Cannot write through a readonly transaction",
    );
  }

  *commit(): Generator<DBCmd, void> {
    yield* this.rollback();
  }

  *rollback(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.state.txCounter.val--;
    if (this.state.txCounter.val !== 0) return;

    this.state.rollbacked.val = true;
    if (this.state.primaryTx) {
      yield* this.state.primaryTx.rollback();
    }
  }

  private throwIfDone(): void {
    if (this.state.rollbacked.val) {
      throw new HyperDBError(
        "TRANSACTION_FINISHED",
        "Cannot modify a rollbacked tx",
      );
    }
  }
}

class HybridDBTx implements HyperDBTx {
  private hybridDB: HybridDB;
  private cacheTx: HyperDBTx;
  private state: HybridDBTxState;
  private traits: Trait[];

  constructor(
    hybridDB: HybridDB,
    cacheTx: HyperDBTx,
    releaseLock: () => void,
    state: HybridDBTxState = createHybridDBTxState(releaseLock),
    traits: Trait[] = [],
  ) {
    this.hybridDB = hybridDB;
    this.cacheTx = cacheTx;
    this.state = state;
    this.traits = traits;
  }

  withTraits(...traits: Trait[]): HyperDBTx {
    return new HybridDBTx(
      this.hybridDB,
      this.cacheTx,
      this.state.releaseLock,
      this.state,
      [...this.traits, ...traits],
    );
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.hybridDB.getTraits()];
  }

  getId(): string {
    return this.hybridDB.getId();
  }

  getDBName(): string | undefined {
    return this.hybridDB.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.hybridDB.getTracer?.();
  }

  getOptions(): CodecOptions {
    return this.hybridDB.getOptions?.() ?? DEFAULT_CODEC_OPTIONS;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *loadTables(): Generator<DBCmd, void> {
    throw new Error("Not supported");
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    _specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    throw new Error(
      "preloadTables is not supported inside HybridDB transactions",
    );
  }

  *beginTx(
    _mode: DBTransactionMode = "readwrite",
  ): Generator<DBCmd, HyperDBTx> {
    this.throwIfDone();
    this.hybridDB.throwIfCrashed();
    this.state.txCounter.val++;
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
    this.hybridDB.throwIfCrashed();
    const traceContext = getDriverTraceContextForDB(this);
    const { hybridDB } = this;
    const ownPendingIds = new Set(
      this.state.pendingWrites
        .filter((write) => write.table === table)
        .map((write) => write.id),
    );
    return yield* hybridIntervalScan(
      withDriverTraceContextTrait(hybridDB.primary, traceContext),
      withDriverTraceContextTrait(this.cacheTx, traceContext),
      this.state.cachedIntervals,
      getCurrentSelectEventForDB(this),
      table,
      indexName,
      clauses,
      selectOptions,
      {
        additionalCachedIntervals: [hybridDB.state.cachedIntervals],
        onPersistentScan: (info) => {
          hybridDB.emitPersistentScanDebugEvent(
            "readwrite-tx",
            table,
            indexName,
            clauses,
            selectOptions,
            info,
          );
        },
        beforePersistentScan: function* (target: IntervalTarget) {
          yield* hybridDB.waitForPendingPersistenceForScan(
            table,
            indexName,
            clauses,
            selectOptions,
            target,
          );
        },
        filterPersistentRows: (_target, rows) =>
          rows.filter((row) => !ownPendingIds.has(row.id)),
        returnCacheAfterPersistentScan: (target) =>
          pendingWritesMatchTarget(this.state.pendingWrites, table, target),
      },
    );
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.hybridDB.throwIfCrashed();
    const traceContext = getDriverTraceContextForDB(this);
    const snapshots = cloneDeep(records);
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).insert(
      table,
      snapshots,
    );
    if (this.cacheTx.getOptions?.().freezeRows) deepFreeze(records);
    for (const record of snapshots as Row[]) {
      this.state.pendingWrites.push({
        table,
        id: record.id,
        newValue: record,
        oldValueKnown: true,
      });
    }
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.hybridDB.throwIfCrashed();
    const traceContext = getDriverTraceContextForDB(this);
    const snapshots = cloneDeep(records);
    const previousRecords = yield* this.getCachedRowsById(
      table,
      snapshots.map((record) => record.id),
    );
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).upsert(
      table,
      snapshots,
    );
    if (this.cacheTx.getOptions?.().freezeRows) deepFreeze(records);
    for (const record of snapshots as Row[]) {
      const oldValue = previousRecords.get(record.id);
      this.state.pendingWrites.push({
        table,
        id: record.id,
        oldValue,
        newValue: record,
        oldValueKnown: oldValue !== undefined,
      });
    }
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    this.hybridDB.throwIfCrashed();
    const traceContext = getDriverTraceContextForDB(this);
    const previousRecords = yield* this.getCachedRowsById(table, ids);
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).delete(
      table,
      ids,
    );
    for (const id of ids) {
      const oldValue = previousRecords.get(id);
      this.state.pendingWrites.push({
        table,
        id,
        oldValue,
        oldValueKnown: oldValue !== undefined,
      });
    }
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.state.txCounter.val--;
    if (this.state.txCounter.val !== 0) return;

    try {
      // Checked inside the try so the finally still releases the lock. A
      // crashed DB must not publish new cache/coverage state or enqueue
      // persistence that can never reach the primary.
      this.hybridDB.throwIfCrashed();
      this.hybridDB.throwIfPersistenceFull(this.state.pendingWrites);
      yield* this.cacheTx.commit();
      mergeExactUniqhashWriteCoverage(
        this.state.cachedIntervals,
        this.state.pendingWrites,
      );
      this.hybridDB.mergeTxCoverage(this.state.cachedIntervals);
      this.hybridDB.enqueuePersistence(
        [...this.state.pendingWrites],
        getDriverTraceContextForDB(this),
      );
      this.state.committed.val = true;
    } catch (error) {
      try {
        yield* this.cacheTx.rollback();
      } catch {
        // Preserve the original commit error.
      }
      this.state.rollbacked.val = true;
      throw error;
    } finally {
      this.state.releaseLock();
    }
  }

  *rollback(): Generator<DBCmd, void> {
    if (this.state.rollbacked.val) return;
    this.throwIfDone();
    let rollbackError: unknown;
    try {
      try {
        yield* this.cacheTx.rollback();
      } catch (error) {
        rollbackError ??= error;
      }
      this.state.rollbacked.val = true;
      if (rollbackError) {
        throw rollbackError;
      }
    } finally {
      this.state.releaseLock();
    }
  }

  private throwIfDone() {
    if (this.state.committed.val) {
      throw new HyperDBError(
        "TRANSACTION_FINISHED",
        "Cannot modify a committed tx",
      );
    }

    if (this.state.rollbacked.val) {
      throw new HyperDBError(
        "TRANSACTION_FINISHED",
        "Cannot modify a rollbacked tx",
      );
    }
  }

  private *getCachedRowsById<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, Map<string, Row>> {
    if (ids.length === 0) return new Map();

    const rows = (yield* this.cacheTx.intervalScan(
      table,
      table.idIndexName as keyof ExtractIndexes<TTable>,
      ids.map((id) => ({ eq: [{ col: "id", val: id }] })),
    )) as Row[];
    return new Map(rows.map((row) => [row.id, row]));
  }
}
