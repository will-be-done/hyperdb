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
  type HyperDBTracerOption,
} from "../core/tracer";
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
  private state: HybridDBState;

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
    yield* withHybridLock(this.state, function* () {
      yield* this.primary.loadTables(tables);
      yield* this.cache.loadTables(tables);
      this.state.cachedIntervals.clear();
    }.bind(this));
  }

  *beginTx(): Generator<DBCmd, HyperDBTx> {
    const release = yield* acquireHybridLock(this.state);
    let primaryTx: HyperDBTx | undefined;
    try {
      primaryTx = yield* this.primary.beginTx();
      const cacheTx = yield* this.cache.beginTx();
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
    return yield* withHybridLock(this.state, function* () {
      return yield* hybridIntervalScan(
        this.primary,
        this.cache,
        this.state.cachedIntervals,
        getCurrentSelectEventForDB(this),
        table,
        indexName,
        clauses,
        selectOptions,
      );
    }.bind(this));
  }

  *insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    yield* withHybridLock(this.state, function* () {
      yield* this.primary.insert(table, records);
      yield* this.cache.insert(table, records);
    }.bind(this));
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    yield* withHybridLock(this.state, function* () {
      yield* this.primary.upsert(table, records);
      yield* this.cache.upsert(table, records);
    }.bind(this));
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    yield* withHybridLock(this.state, function* () {
      yield* this.primary.delete(table, ids);
      yield* this.cache.delete(table, ids);
    }.bind(this));
  }

  mergeTxCoverage(intervals: HybridIntervalCache): void {
    mergeCoverageMaps(this.state.cachedIntervals, intervals);
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

  *loadTables(): Generator<DBCmd, void> {
    throw new Error("Not supported");
  }

  *beginTx(): Generator<DBCmd, HyperDBTx> {
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
    return yield* hybridIntervalScan(
      this.primaryTx,
      this.cacheTx,
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
    yield* this.primaryTx.insert(table, records);
    yield* this.cacheTx.insert(table, records);
  }

  *upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    yield* this.primaryTx.upsert(table, records);
    yield* this.cacheTx.upsert(table, records);
  }

  *delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    yield* this.primaryTx.delete(table, ids);
    yield* this.cacheTx.delete(table, ids);
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
