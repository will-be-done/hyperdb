import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
import type { HyperDB, HyperDBTx } from "../core/contracts";
import {
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
import {
  createHybridIntervalCache,
  hybridIntervalScan,
  mergeCoverageMaps,
  type HybridIntervalCache,
} from "./hybrid-db-intervals";

type HybridDBState = {
  cachedIntervals: HybridIntervalCache;
  lock: AwaitLock;
};

type HybridDBTxState = {
  cachedIntervals: HybridIntervalCache;
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

const createHybridDBState = (): HybridDBState => ({
  cachedIntervals: createHybridIntervalCache(),
  lock: new AwaitLock(),
});

const createHybridDBTxState = (releaseLock: () => void): HybridDBTxState => ({
  cachedIntervals: createHybridIntervalCache(),
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

export class HybridDB implements HyperDB {
  primary: HyperDB;
  cache: HyperDB;
  traits: Trait[] = [];
  state: HybridDBState;

  constructor(primary: HyperDB, cache: HyperDB, options: HybridDBOptions = {}) {
    this.primary = primary;
    this.cache = cache;
    this.traits = options.traits ?? [];
    this.state = createHybridDBState();
  }

  withTraits(...traits: Trait[]): HyperDB {
    const db = new HybridDB(this.primary, this.cache, {
      traits: [...this.traits, ...traits],
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
    const { cache, primary, state } = this;
    yield* withHybridLock(this.state, function* () {
      yield* primary.loadTables(tables);
      yield* cache.loadTables(tables);
      state.cachedIntervals.clear();
    });
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, HyperDBTx> {
    if (mode === "readonly") {
      return new HybridDBReadonlyTx(this);
    }

    const release = yield* acquireHybridLock(this.state);
    const primary = withDriverTraceContextTrait(
      this.primary,
      getDriverTraceContextForDB(this),
    );
    const cache = withDriverTraceContextTrait(
      this.cache,
      getDriverTraceContextForDB(this),
    );
    let primaryTx: HyperDBTx | undefined;
    try {
      primaryTx = yield* primary.beginTx("readwrite");
      const cacheTx = yield* cache.beginTx("readwrite");
      return new HybridDBTx(this, primaryTx, cacheTx, release);
    } catch (error) {
      if (primaryTx) {
        try {
          yield* primaryTx.rollback();
        } catch {
          // Preserve the original beginTx error.
        }
      }
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
    const { cache, primary, state } = this;
    const selectEvent = getCurrentSelectEventForDB(this);
    const traceContext = getDriverTraceContextForDB(this);
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
      );
    });
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
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
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
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
    const { cache, primary } = this;
    const traceContext = getDriverTraceContextForDB(this);
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

  *beginTx(
    _mode: DBTransactionMode = "readwrite",
  ): Generator<DBCmd, HyperDBTx> {
    this.throwIfDone();
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
    const { cache, state } = this.hybridDB;
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

    return yield* withHybridLock(
      state,
      function* () {
        return yield* hybridIntervalScan(
          getPrimaryForRead,
          withDriverTraceContextTrait(cache, traceContext),
          state.cachedIntervals,
          selectEvent,
          table,
          indexName,
          clauses,
          selectOptions,
        );
      }.bind(this),
    );
  }

  *insert<TTable extends TableDefinition>(
    _table: TTable,
    _records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    throw new Error("Cannot write through a readonly transaction");
  }

  *upsert<TTable extends TableDefinition>(
    _table: TTable,
    _records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    throw new Error("Cannot write through a readonly transaction");
  }

  *delete<TTable extends TableDefinition>(
    _table: TTable,
    _ids: string[],
  ): Generator<DBCmd, void> {
    throw new Error("Cannot write through a readonly transaction");
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
      throw new Error("Cannot modify a rollbacked tx");
    }
  }
}

class HybridDBTx implements HyperDBTx {
  private hybridDB: HybridDB;
  private primaryTx: HyperDBTx;
  private cacheTx: HyperDBTx;
  private state: HybridDBTxState;
  private traits: Trait[];

  constructor(
    hybridDB: HybridDB,
    primaryTx: HyperDBTx,
    cacheTx: HyperDBTx,
    releaseLock: () => void,
    state: HybridDBTxState = createHybridDBTxState(releaseLock),
    traits: Trait[] = [],
  ) {
    this.hybridDB = hybridDB;
    this.primaryTx = primaryTx;
    this.cacheTx = cacheTx;
    this.state = state;
    this.traits = traits;
  }

  withTraits(...traits: Trait[]): HyperDBTx {
    return new HybridDBTx(
      this.hybridDB,
      this.primaryTx,
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

  *beginTx(
    _mode: DBTransactionMode = "readwrite",
  ): Generator<DBCmd, HyperDBTx> {
    this.throwIfDone();
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
    const traceContext = getDriverTraceContextForDB(this);
    return yield* hybridIntervalScan(
      withDriverTraceContextTrait(this.primaryTx, traceContext),
      withDriverTraceContextTrait(this.cacheTx, traceContext),
      this.state.cachedIntervals,
      getCurrentSelectEventForDB(this),
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
    const traceContext = getDriverTraceContextForDB(this);
    yield* withDriverTraceContextTrait(this.primaryTx, traceContext).insert(
      table,
      records,
    );
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).insert(
      table,
      records,
    );
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    const traceContext = getDriverTraceContextForDB(this);
    yield* withDriverTraceContextTrait(this.primaryTx, traceContext).upsert(
      table,
      records,
    );
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).upsert(
      table,
      records,
    );
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    const traceContext = getDriverTraceContextForDB(this);
    yield* withDriverTraceContextTrait(this.primaryTx, traceContext).delete(
      table,
      ids,
    );
    yield* withDriverTraceContextTrait(this.cacheTx, traceContext).delete(
      table,
      ids,
    );
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    this.state.txCounter.val--;
    if (this.state.txCounter.val !== 0) return;

    let primaryCommitted = false;
    try {
      yield* this.primaryTx.commit();
      primaryCommitted = true;
      yield* this.cacheTx.commit();
      this.hybridDB.mergeTxCoverage(this.state.cachedIntervals);
      this.state.committed.val = true;
    } catch (error) {
      if (!primaryCommitted) {
        try {
          yield* this.primaryTx.rollback();
        } catch {
          // Preserve the original commit error.
        }
      }
      try {
        yield* this.cacheTx.rollback();
      } catch {
        // Preserve the original commit error.
      }
      throw error;
    } finally {
      this.state.releaseLock();
    }
  }

  *rollback(): Generator<DBCmd, void> {
    this.throwIfDone();
    let rollbackError: unknown;
    try {
      try {
        yield* this.primaryTx.rollback();
      } catch (error) {
        rollbackError = error;
      }
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
      throw new Error("Cannot modify a committed tx");
    }

    if (this.state.rollbacked.val) {
      throw new Error("Cannot modify a rollbacked tx");
    }
  }
}
