/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionGenerator } from "../commands/command-types";
import type {
  HyperDB,
  HyperDBTx,
  HybridPreloadTableSpecInput,
  ValidateHybridPreloadTableSpecs,
} from "../core/contracts";
import type {
  Row,
  SelectOptions,
  Trait,
  WhereClause,
} from "../core/primitives";
import { runCommandGenerator } from "../commands/runner";
import type { DBCmd } from "../commands/async";
import {
  DEFAULT_CODEC_OPTIONS,
  normalizeRecordsForDriver,
  tableStoresArrayBuffers,
  type CodecOptions,
} from "../storage/codec";
import { deepFreeze } from "../deep-freeze";
import type { DBTransactionMode } from "../core/driver";
// import { collectAll } from "../commands/async";
import type {
  ExtractIndexes,
  ExtractSchema,
  ExtractSchemaInput,
  TableDefinition,
} from "../schema/table";
import {
  createTraceFrameMeta,
  getTraceContextForDB,
  withoutInternalTraits,
  type HyperDBTracerOption,
  type TraceContext,
} from "../core/tracer";
import { wrapGeneratorWithExistingTracePath } from "../tracing/metadata";
import { dbClosedError, refVar, type RefVar } from "../utils";
import { HyperDBError } from "../core/errors";

export type { InsertOp, UpsertOp, DeleteOp, Op } from "./ops";

import type { InsertOp, UpsertOp, DeleteOp, Op } from "./ops";

// Hooks and subscribers treat `newValue` as the stored row. A typed array or
// DataView written to a binary column is stored as an ArrayBuffer, so rows
// that may hold one are passed on in their stored form.
function rowsAsStored(
  table: TableDefinition,
  records: Row[],
  options: CodecOptions,
): Row[] {
  if (!tableStoresArrayBuffers(table)) return records;
  const rows = normalizeRecordsForDriver(table, records, options);
  if (options.freezeRows) deepFreeze(rows);
  return rows;
}

type Subscriber = (
  op: readonly Op[],
  traits: Trait[],
  revision: number,
) => void;

const notifySubscribers = (
  subscribers: Subscriber[],
  operations: readonly Op[],
  traits: Trait[],
  revision: number,
) => {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(operations, traits, revision);
    } catch (error) {
      console.error(error);
    }
  }
};

type AfterInsertSub = (
  db: HyperDB,
  table: TableDefinition,
  traits: Trait[],
  ops: InsertOp[],
) => ActionGenerator<void>;

type AfterUpsertSub = (
  db: HyperDB,
  table: TableDefinition,
  traits: Trait[],
  ops: UpsertOp[],
) => ActionGenerator<void>;

type AfterDeleteSub = (
  db: HyperDB,
  table: TableDefinition,
  traits: Trait[],
  ops: DeleteOp[],
) => ActionGenerator<void>;

type AfterChangeSub = (
  db: HyperDB,
  table: TableDefinition,
  traits: Trait[],
  ops: Op[],
) => ActionGenerator<void>;

export type AfterScanCallback = (
  db: HyperDB,
  table: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions | undefined,
  results: Row[],
) => ActionGenerator<unknown>;

const wrapAfterScanCallbackGenerator = (
  cb: AfterScanCallback,
  gen: Generator<unknown, unknown, unknown>,
  table: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions | undefined,
  results: Row[],
  traceContext: TraceContext | undefined,
): Generator<unknown, unknown, unknown> => {
  if (!traceContext) return gen;

  const afterScanMeta = createTraceFrameMeta(
    "unknown",
    cb.name || "afterScan",
    {
      tableName: table.tableName,
      indexName,
      clauses,
      selectOptions,
      resultCount: results.length,
    },
  );

  return wrapGeneratorWithExistingTracePath(gen, [
    ...traceContext.frameMetas,
    afterScanMeta,
  ]);
};

function* runAfterScanSubscribers(
  db: HyperDB,
  subscribers: AfterScanCallback[],
  table: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
  selectOptions: SelectOptions | undefined,
  results: Row[],
): Generator<DBCmd, void> {
  const traceContext = getTraceContextForDB(db);
  for (const cb of subscribers) {
    const gen = cb(db, table, indexName, clauses, selectOptions, results);
    yield* runCommandGenerator(
      db,
      wrapAfterScanCallbackGenerator(
        cb,
        gen,
        table,
        indexName,
        clauses,
        selectOptions,
        results,
        traceContext,
      ),
      { allowWrites: true, traceContext },
    );
  }
}

function appendOps(target: Op[], ops: Op[]) {
  for (const op of ops) {
    target.push(op);
  }
}

function removeSubscriber<T>(subscribers: T[], cb: T) {
  for (let i = subscribers.length - 1; i >= 0; i--) {
    if (subscribers[i] === cb) {
      subscribers.splice(i, 1);
    }
  }
}

type SubscribableDBTxState = {
  operations: Op[];
  committed: RefVar<boolean>;
  rollbacked: RefVar<boolean>;
  txCounter: RefVar<number>;
  // First error from a hook that ran after its write was applied.
  hookFailure?: { error: unknown };
};

const createSubscribableDBTxState = (): SubscribableDBTxState => ({
  operations: [],
  committed: refVar(false),
  rollbacked: refVar(false),
  txCounter: refVar(1),
});

type SubscribableDBState = {
  subscribers: Subscriber[];
  afterInsertSubscribers: AfterInsertSub[];
  afterUpsertSubscribers: AfterUpsertSub[];
  afterDeleteSubscribers: AfterDeleteSub[];
  afterChangeSubscribers: AfterChangeSub[];
  afterScanSubscribers: AfterScanCallback[];
  revision: RefVar<number>;
  closed: boolean;
  closeCallbacks: (() => void)[];
};

const createSubscribableDBState = (): SubscribableDBState => ({
  subscribers: [],
  afterInsertSubscribers: [],
  afterUpsertSubscribers: [],
  afterDeleteSubscribers: [],
  afterChangeSubscribers: [],
  afterScanSubscribers: [],
  revision: refVar(0),
  closed: false,
  closeCallbacks: [],
});

export class SubscribableDBTx implements HyperDBTx {
  // NOTE: ops could be optimized bu zipping them + each tx type will be in insert, upsert, delete batches.
  // That will make async db tx apply very fast. Right now we need to wait each op of tx to finish
  // before applying next one. Cause otherwise if we will do in unordered way, we could get upsert before insert, for example.
  private subDb: SubscribableDB;
  private txDb: HyperDBTx;
  private state: SubscribableDBTxState;
  private traits: Trait[];

  constructor(
    subDb: SubscribableDB,
    txDb: HyperDBTx,
    state: SubscribableDBTxState = createSubscribableDBTxState(),
    traits: Trait[] = [],
  ) {
    this.subDb = subDb;
    this.txDb = txDb;
    this.state = state;
    this.traits = traits;
  }

  get operations(): Op[] {
    return this.state.operations;
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.subDb.getTraits()];
  }

  getId(): string {
    return this.subDb.getId();
  }

  getDBName(): string | undefined {
    return this.subDb.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.subDb.getTracer?.();
  }

  recordsMutationTraceEvents(): boolean {
    return true;
  }

  getOptions(): CodecOptions {
    return this.subDb.getOptions?.() ?? DEFAULT_CODEC_OPTIONS;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return false;
  }

  *loadTables(): Generator<DBCmd, void> {
    throw new Error("Not supported");
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    yield* this.delegateTx().preloadTables(specs);
  }

  private delegateTx(): HyperDBTx {
    return this.traits.length > 0
      ? (this.txDb.withTraits(...this.traits) as HyperDBTx)
      : this.txDb;
  }

  withTraits<TTrait extends Trait>(...traits: TTrait[]): HyperDBTx {
    return new SubscribableDBTx(this.subDb, this.txDb, this.state, [
      ...this.traits,
      ...traits,
    ]);
  }

  *beginTx(
    _mode: DBTransactionMode = "readwrite",
  ): Generator<DBCmd, HyperDBTx> {
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

    const results = yield* this.delegateTx().intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );

    try {
      yield* runAfterScanSubscribers(
        this,
        this.subDb.afterScanSubscribers,
        table,
        String(indexName),
        clauses,
        selectOptions,
        results as Row[],
      );
    } catch (error) {
      // afterScan hooks may write; their partial writes must not commit.
      this.state.hookFailure ??= { error };
      throw error;
    }

    return results;
  }

  *insert<TTable extends TableDefinition<any>>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    if (records.length === 0) return;

    const traceContext = getTraceContextForDB(this);
    const mutationEvent = traceContext
      ? traceContext.tracer.beginMutationEvent(
          traceContext,
          traceContext.tracer.getCurrentTraceFrame(traceContext),
          {
            kind: "insert",
            tableName: table.tableName,
            newValue: records,
            rows: records,
          },
        )
      : undefined;

    try {
      yield* this.delegateTx().insert(table, records);
    } catch (error) {
      if (traceContext && mutationEvent) {
        traceContext.tracer.endMutationEventError(
          traceContext,
          mutationEvent,
          error,
        );
      }
      throw error;
    }

    const insertOps = rowsAsStored(table, records, this.getOptions()).map(
      (r) =>
        ({
          type: "insert",
          table,
          newValue: r,
        }) satisfies InsertOp,
    );
    appendOps(this.operations, insertOps);
    if (traceContext && mutationEvent) {
      traceContext.tracer.endMutationEventSuccess(traceContext, mutationEvent, {
        newValue: records,
        rows: records,
      });
    }

    yield* this.runMutationHooks(
      this.subDb.afterInsertSubscribers,
      table,
      insertOps,
      traceContext,
    );
    yield* this.runMutationHooks(
      this.subDb.afterChangeSubscribers,
      table,
      insertOps,
      traceContext,
    );
  }

  *upsert<TTable extends TableDefinition<any>>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    if (records.length === 0) return;

    let upsertRecords = records;
    const recordIds = new Set<string>();
    let hasDuplicateIds = false;
    for (const record of records) {
      if (recordIds.has(record.id)) {
        hasDuplicateIds = true;
        break;
      }
      recordIds.add(record.id);
    }

    if (hasDuplicateIds) {
      const seenIds = new Set<string>();
      upsertRecords = [];
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i];
        if (seenIds.has(record.id)) continue;
        seenIds.add(record.id);
        upsertRecords.push(record);
      }
      upsertRecords.reverse();
    }

    const previousRecords = new Map<string, Row>();
    const traceContext = getTraceContextForDB(this);
    const mutationEvent = traceContext
      ? traceContext.tracer.beginMutationEvent(
          traceContext,
          traceContext.tracer.getCurrentTraceFrame(traceContext),
          {
            kind: "upsert",
            tableName: table.tableName,
            newValue: upsertRecords,
            rows: upsertRecords,
          },
        )
      : undefined;

    try {
      for (const oldRecord of yield* this.delegateTx().intervalScan(
        table,
        table.idIndexName,
        upsertRecords.map((r) => ({ eq: [{ col: "id", val: r.id }] })),
      )) {
        previousRecords.set(oldRecord.id, oldRecord);
      }

      yield* this.delegateTx().upsert(table, upsertRecords);
    } catch (error) {
      if (traceContext && mutationEvent) {
        traceContext.tracer.endMutationEventError(
          traceContext,
          mutationEvent,
          error,
        );
      }
      throw error;
    }

    const upsertOps = rowsAsStored(table, upsertRecords, this.getOptions()).map(
      (record) =>
        ({
          type: "upsert",
          table,
          oldValue: previousRecords.get(record.id),
          newValue: record,
        }) satisfies UpsertOp,
    );
    appendOps(this.operations, upsertOps);
    if (traceContext && mutationEvent) {
      traceContext.tracer.endMutationEventSuccess(traceContext, mutationEvent, {
        oldValue: Array.from(previousRecords.values()),
        newValue: upsertRecords,
        rows: upsertRecords,
      });
    }

    yield* this.runMutationHooks(
      this.subDb.afterUpsertSubscribers,
      table,
      upsertOps,
      traceContext,
    );
    yield* this.runMutationHooks(
      this.subDb.afterChangeSubscribers,
      table,
      upsertOps,
      traceContext,
    );
  }

  *delete<TTable extends TableDefinition<any>>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void> {
    this.throwIfDone();
    if (ids.length === 0) return;

    const deleteOps: DeleteOp[] = [];
    const traceContext = getTraceContextForDB(this);
    const mutationEvent = traceContext
      ? traceContext.tracer.beginMutationEvent(
          traceContext,
          traceContext.tracer.getCurrentTraceFrame(traceContext),
          {
            kind: "delete",
            tableName: table.tableName,
            ids,
          },
        )
      : undefined;

    try {
      for (const oldRecord of yield* this.delegateTx().intervalScan(
        table,
        table.idIndexName,
        ids.map((id) => ({ eq: [{ col: "id", val: id }] })),
      )) {
        deleteOps.push({ type: "delete", table, oldValue: oldRecord });
      }

      yield* this.delegateTx().delete(table, ids);
      appendOps(this.operations, deleteOps);
    } catch (error) {
      if (traceContext && mutationEvent) {
        traceContext.tracer.endMutationEventError(
          traceContext,
          mutationEvent,
          error,
        );
      }
      throw error;
    }

    if (traceContext && mutationEvent) {
      traceContext.tracer.endMutationEventSuccess(traceContext, mutationEvent, {
        ids,
        oldValue: deleteOps.map((op) => op.oldValue),
      });
    }

    yield* this.runMutationHooks(
      this.subDb.afterDeleteSubscribers,
      table,
      deleteOps,
      traceContext,
    );
    yield* this.runMutationHooks(
      this.subDb.afterChangeSubscribers,
      table,
      deleteOps,
      traceContext,
    );
  }

  // Hooks run after their write is applied. If one fails, the transaction can
  // no longer commit, so a handler that catches the error cannot publish the
  // write without the hook's own changes.
  private *runMutationHooks<TOp extends Op>(
    hooks: ((
      db: HyperDB,
      table: TableDefinition,
      traits: Trait[],
      ops: TOp[],
    ) => ActionGenerator<void>)[],
    table: TableDefinition,
    ops: TOp[],
    traceContext: TraceContext | undefined,
  ): Generator<DBCmd, void> {
    try {
      for (const cb of hooks) {
        yield* runCommandGenerator(
          this,
          cb(this, table, withoutInternalTraits(this.getTraits()), ops),
          { allowWrites: true, traceContext },
        );
      }
    } catch (error) {
      this.state.hookFailure ??= { error };
      throw error;
    }
  }

  *rollback(): Generator<DBCmd, void> {
    this.throwIfDone();
    yield* this.txDb.rollback();
    this.state.rollbacked.val = true;
  }

  *commit(): Generator<DBCmd, void> {
    this.throwIfDone();
    if (this.state.hookFailure) throw this.state.hookFailure.error;
    this.state.txCounter.val--;
    if (this.state.txCounter.val !== 0) return;

    try {
      yield* this.txDb.commit();
    } catch (error) {
      // Like the inner tx: a second commit() must reach it again, not return
      // as committed without notifying subscribers.
      this.state.txCounter.val++;
      throw error;
    }
    this.state.committed.val = true;

    // if (this.operations.length === 0) return;

    const traits = withoutInternalTraits(this.getTraits());
    const revision = this.subDb.incrementRevision();
    // Every subscriber shares this array, so none may change it for the rest.
    notifySubscribers(
      this.subDb.subscribers,
      Object.freeze(this.operations.map((op) => Object.freeze(op))),
      traits,
      revision,
    );
  }

  throwIfDone() {
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
}

export class SubscribableDB implements HyperDB {
  db: HyperDB;

  traits: Trait[] = [];
  private state: SubscribableDBState;

  constructor(db: HyperDB);
  constructor(db: HyperDB, state: SubscribableDBState, traits?: Trait[]);
  constructor(
    db: HyperDB,
    state: SubscribableDBState = createSubscribableDBState(),
    traits: Trait[] = [],
  ) {
    this.db = db;
    this.traits = traits;
    this.state = state;
  }

  get subscribers(): Subscriber[] {
    return this.state.subscribers;
  }

  get afterInsertSubscribers(): AfterInsertSub[] {
    return this.state.afterInsertSubscribers;
  }

  get afterUpsertSubscribers(): AfterUpsertSub[] {
    return this.state.afterUpsertSubscribers;
  }

  get afterDeleteSubscribers(): AfterDeleteSub[] {
    return this.state.afterDeleteSubscribers;
  }

  get afterChangeSubscribers(): AfterChangeSub[] {
    return this.state.afterChangeSubscribers;
  }

  get afterScanSubscribers(): AfterScanCallback[] {
    return this.state.afterScanSubscribers;
  }

  getRevision(): number {
    return this.state.revision.val;
  }

  incrementRevision(): number {
    this.state.revision.val++;
    return this.state.revision.val;
  }

  // The wrapped DB may not track closing itself (close() is optional).
  private throwIfClosed(): void {
    if (this.state.closed) throw dbClosedError();
  }

  private delegateDB(): HyperDB {
    this.throwIfClosed();
    return this.traits.length > 0
      ? this.db.withTraits(...this.traits)
      : this.db;
  }

  // Generator methods, so a closed DB fails when the command runs, not when
  // it is created.
  *loadTables(tables: TableDefinition<any>[]): Generator<DBCmd, void> {
    this.throwIfClosed();
    yield* this.db.loadTables(tables);
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {
    yield* this.delegateDB().preloadTables(specs);
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, HyperDBTx> {
    return new SubscribableDBTx(this, yield* this.delegateDB().beginTx(mode));
  }

  *waitForPersistence(): Generator<DBCmd, void> {
    const db = this.delegateDB();
    if (db.waitForPersistence) yield* db.waitForPersistence();
  }

  getCacheDB(): HyperDB | undefined {
    return this.db.getCacheDB?.();
  }

  get isClosed(): boolean {
    return this.state.closed || this.db.isClosed === true;
  }

  /** @internal Runs once when this DB closes, e.g. to release derived caches. */
  onClose(cb: () => void): void {
    this.state.closeCallbacks.push(cb);
  }

  /** @internal Drops subscribers and hooks without closing the wrapped DB. */
  clearSubscriptions(): void {
    const { state } = this;
    state.subscribers.length = 0;
    state.afterInsertSubscribers.length = 0;
    state.afterUpsertSubscribers.length = 0;
    state.afterDeleteSubscribers.length = 0;
    state.afterChangeSubscribers.length = 0;
    state.afterScanSubscribers.length = 0;
  }

  *close(): Generator<DBCmd, void> {
    // Closing is terminal for new operations, even if resource cleanup fails.
    this.state.closed = true;
    try {
      if (this.db.close) yield* this.db.close();
    } finally {
      // Release listeners even if the wrapped DB failed to close.
      this.clearSubscriptions();
      for (const cb of this.state.closeCallbacks.splice(0)) cb();
    }
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return this.delegateDB().canUseReadonlyTransactionsForSelectors();
  }

  withTraits<TTrait extends Trait>(...traits: TTrait[]): HyperDB {
    const db = new SubscribableDB(this.db);
    db.state = this.state;
    db.traits = [...this.traits, ...traits];
    return db;
  }

  getTraits(): Trait[] {
    return [...this.traits, ...this.db.getTraits()];
  }

  getId(): string {
    return this.db.getId();
  }

  getDBName(): string | undefined {
    return this.db.getDBName?.();
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.db.getTracer?.();
  }

  getOptions(): CodecOptions {
    return this.db.getOptions?.() ?? DEFAULT_CODEC_OPTIONS;
  }

  afterInsert(cb: AfterInsertSub): () => void {
    this.afterInsertSubscribers.push(cb);

    return () => {
      removeSubscriber(this.afterInsertSubscribers, cb);
    };
  }

  afterUpsert(cb: AfterUpsertSub): () => void {
    this.afterUpsertSubscribers.push(cb);

    return () => {
      removeSubscriber(this.afterUpsertSubscribers, cb);
    };
  }

  afterDelete(cb: AfterDeleteSub): () => void {
    this.afterDeleteSubscribers.push(cb);

    return () => {
      removeSubscriber(this.afterDeleteSubscribers, cb);
    };
  }

  afterChange(cb: AfterChangeSub): () => void {
    this.afterChangeSubscribers.push(cb);

    return () => {
      removeSubscriber(this.afterChangeSubscribers, cb);
    };
  }

  afterScan(cb: AfterScanCallback): () => void {
    this.afterScanSubscribers.push(cb);

    return () => {
      removeSubscriber(this.afterScanSubscribers, cb);
    };
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.push(cb);

    return () => {
      removeSubscriber(this.subscribers, cb);
    };
  }

  *intervalScan<
    TTable extends TableDefinition<any, any>,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Generator<DBCmd, ExtractSchema<TTable>[]> {
    this.throwIfClosed();
    if (clauses && clauses.length === 0) {
      const results: ExtractSchema<TTable>[] = [];

      yield* runAfterScanSubscribers(
        this,
        this.afterScanSubscribers,
        table,
        String(indexName),
        clauses,
        selectOptions,
        results as Row[],
      );

      return results;
    }

    const results = yield* this.delegateDB().intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );

    yield* runAfterScanSubscribers(
      this,
      this.afterScanSubscribers,
      table,
      String(indexName),
      clauses,
      selectOptions,
      results as Row[],
    );

    return results;
  }

  *insert<TTable extends TableDefinition<any>>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ): Generator<DBCmd, void> {
    if (records.length === 0) return;

    const tx = yield* this.beginTx();

    yield* tx.insert(table, records);
    yield* tx.commit();
  }

  *upsert<TTable extends TableDefinition<any>>(
    table: TTable,
    records: ExtractSchemaInput<TTable>[],
  ) {
    if (records.length === 0) return;

    const tx = yield* this.beginTx();

    yield* tx.upsert(table, records);
    yield* tx.commit();
  }

  *delete<TTable extends TableDefinition<any>>(table: TTable, ids: string[]) {
    if (ids.length === 0) return;

    const tx = yield* this.beginTx();

    yield* tx.delete(table, ids);
    yield* tx.commit();
  }
}
