import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
import type { HyperDB } from "../core/contracts";
import { execAsync } from "../core/executor";
import type { Row } from "../core/primitives";
import type { TableDefinition } from "../schema/table";
import { HyperDBError } from "../core/errors";
import { dbClosedError } from "../utils";

/**
 * Thrown by every HybridDB read/write once background persistence has
 * permanently failed (all retries exhausted). The HybridDB is considered
 * crashed: its cache and primary may have diverged, so it refuses all further
 * operations rather than serving stale in-memory data. The underlying
 * persistence error is available via `cause`.
 */
export class HybridDBCrashedError extends HyperDBError {
  constructor(cause: unknown) {
    super(
      "HYBRID_DB_CRASHED",
      "HybridDB is in a crashed state after background persistence permanently failed. " +
        "No further reads or writes are allowed.",
      { cause },
    );
    this.name = "HybridDBCrashedError";
  }
}

export type HybridPendingWrite = {
  table: TableDefinition;
  id: string;
  oldValue?: Row;
  newValue?: Row;
  insertOnly?: boolean;
  oldValueKnown: boolean;
};

type HybridPersistenceBatch = {
  id: number;
  writes: HybridPendingWrite[];
  promise: Promise<void>;
};

export type HybridPersistenceFailure = {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  retryDelayMs?: number;
  willRetry: boolean;
};

const hybridPersistenceMaxAttempts = 3;
const hybridPersistenceInitialRetryDelayMs = 10;
const hybridPersistenceRetryBackoffFactor = 2;

const groupByTable = <TValue>(
  values: Iterable<TValue>,
  getTable: (value: TValue) => TableDefinition,
): Map<TableDefinition, TValue[]> => {
  const byTable = new Map<TableDefinition, TValue[]>();
  for (const value of values) {
    const table = getTable(value);
    let tableValues = byTable.get(table);
    if (!tableValues) {
      tableValues = [];
      byTable.set(table, tableValues);
    }
    tableValues.push(value);
  }
  return byTable;
};

export function coalescePersistenceWrites(
  writes: HybridPendingWrite[],
): HybridPendingWrite[] {
  const byTable = new Map<TableDefinition, Map<string, HybridPendingWrite>>();
  for (const write of writes) {
    let tableWrites = byTable.get(write.table);
    if (!tableWrites) {
      tableWrites = new Map();
      byTable.set(write.table, tableWrites);
    }
    const previous = tableWrites.get(write.id);
    tableWrites.set(
      write.id,
      previous ? { ...write, insertOnly: previous.insertOnly } : write,
    );
  }

  return Array.from(byTable.values()).flatMap((tableWrites) =>
    Array.from(tableWrites.values()),
  );
}

function* persistWrites(
  primary: HyperDB,
  writes: HybridPendingWrite[],
): Generator<DBCmd, void> {
  const coalescedWrites = coalescePersistenceWrites(writes);
  if (coalescedWrites.length === 0) return;

  const tx = yield* primary.beginTx("readwrite");
  try {
    const rows = coalescedWrites.filter(
      (write): write is HybridPendingWrite & { newValue: Row } =>
        write.newValue !== undefined,
    );
    const deletes = coalescedWrites.filter(
      (write) => write.newValue === undefined,
    );

    for (const [table, tableWrites] of groupByTable(
      deletes,
      (write) => write.table,
    )) {
      yield* tx.delete(
        table,
        tableWrites.map((write) => write.id),
      );
    }

    for (const [table, tableWrites] of groupByTable(
      rows.filter((write) => !write.insertOnly),
      (write) => write.table,
    )) {
      yield* tx.upsert(
        table,
        tableWrites.map((write) => write.newValue),
      );
    }

    for (const [table, tableWrites] of groupByTable(
      rows.filter((write) => write.insertOnly),
      (write) => write.table,
    )) {
      yield* tx.insert(
        table,
        tableWrites.map((write) => write.newValue),
      );
    }

    yield* tx.commit();
  } catch (error) {
    try {
      yield* tx.rollback();
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

const persistenceRetryDelayMs = (attempt: number): number =>
  hybridPersistenceInitialRetryDelayMs *
  hybridPersistenceRetryBackoffFactor ** (attempt - 1);

const waitForPersistenceRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export class HybridPersistenceQueue {
  static readonly maxPendingBatches = 100;
  readonly pending = new Set<HybridPersistenceBatch>();
  private tail = Promise.resolve();
  private nextBatchId = 1;
  isCrashed = false;
  // Set when close() starts: new commits are refused, accepted ones drain.
  isClosing = false;
  isClosed = false;
  private crashError: unknown;
  private closing?: Promise<void>;
  private acceptedCommits = 0;
  private idleWaiters: (() => void)[] = [];

  throwIfCrashed(): void {
    if (this.isClosing || this.isClosed) {
      throw dbClosedError();
    }
    if (this.isCrashed) throw new HybridDBCrashedError(this.crashError);
  }

  /**
   * Registers a commit that passed the gate but has not enqueued its batch
   * yet, so close() waits for it. Returns the release function.
   */
  acceptCommit(): () => void {
    this.acceptedCommits++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.acceptedCommits--;
      this.notifyIfIdle();
    };
  }

  /**
   * Waits until every accepted commit has enqueued and every batch settled,
   * ignoring a crash; the owner is shutting down.
   */
  *settle(): Generator<DBCmd, void> {
    while (this.acceptedCommits > 0 || this.pending.size > 0) {
      yield* unwrap(
        new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
      );
    }
  }

  /**
   * Runs the owner's close once: refuses new commits, settles accepted ones,
   * then calls `closeOwner`. Concurrent calls wait for the same close. After a
   * failure the DB stays closing, and close() can be retried.
   */
  *close(closeOwner: () => Generator<DBCmd, void>): Generator<DBCmd, void> {
    // A waiter whose close was abandoned (not failed) takes over the close.
    while (this.closing) yield* unwrap(this.closing);
    if (this.isClosed) return;
    let resolveClosing!: () => void;
    let rejectClosing!: (error: unknown) => void;
    const closing = new Promise<void>((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });
    // Only concurrent callers observe the outcome.
    closing.catch(() => {});
    this.closing = closing;
    this.isClosing = true;
    let settled = false;
    try {
      yield* this.settle();
      yield* closeOwner();
      this.isClosed = true;
      settled = true;
      resolveClosing();
    } catch (error) {
      settled = true;
      rejectClosing(error);
      throw error;
    } finally {
      this.closing = undefined;
      // The caller abandoned this close (generator return()); wake the waiting
      // callers so one of them runs the close instead of hanging.
      if (!settled) resolveClosing();
    }
  }

  private notifyIfIdle(): void {
    if (this.acceptedCommits > 0 || this.pending.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // Call before publishing cache changes.
  throwIfFull(writes: HybridPendingWrite[]): void {
    this.throwIfCrashed();
    this.throwIfAtCapacity(writes);
  }

  // A commit that already passed throwIfFull() may enqueue while closing.
  private throwIfAtCapacity(writes: HybridPendingWrite[]): void {
    if (this.isCrashed) throw new HybridDBCrashedError(this.crashError);
    if (
      writes.length > 0 &&
      this.pending.size >= HybridPersistenceQueue.maxPendingBatches
    ) {
      throw new HyperDBError(
        "PERSISTENCE_QUEUE_FULL",
        "Hybrid persistence queue is full. Await waitForPersistence() before retrying the transaction.",
      );
    }
  }

  enqueue(
    primary: HyperDB,
    writes: HybridPendingWrite[],
    onFailure?: (batchId: number, failure: HybridPersistenceFailure) => void,
  ): void {
    this.throwIfAtCapacity(writes);
    if (writes.length === 0) return;
    const batchId = this.nextBatchId++;
    const persistWithRetry = (attempt: number): Promise<void> =>
      execAsync(persistWrites(primary, writes)).catch((error) => {
        const willRetry = attempt < hybridPersistenceMaxAttempts;
        const retryDelayMs = persistenceRetryDelayMs(attempt);
        try {
          onFailure?.(batchId, {
            error,
            attempt,
            maxAttempts: hybridPersistenceMaxAttempts,
            retryDelayMs: willRetry ? retryDelayMs : undefined,
            willRetry,
          });
        } catch {
          // Observers must not affect retries or the permanent crash state.
        }
        if (!willRetry) {
          this.isCrashed = true;
          this.crashError = error;
          throw error;
        }
        return waitForPersistenceRetry(retryDelayMs).then(() =>
          persistWithRetry(attempt + 1),
        );
      });
    const promise = this.tail.then(() => {
      // Only a crash stops queued batches; close() waits for them to drain.
      if (this.isCrashed) throw new HybridDBCrashedError(this.crashError);
      return persistWithRetry(1);
    });
    const batch = { id: batchId, writes, promise };
    this.pending.add(batch);
    this.tail = promise.catch(() => {});
    const settled = () => {
      this.pending.delete(batch);
      this.notifyIfIdle();
    };
    void promise.then(settled, settled);
  }

  *waitForPersistence(): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const pending = [...this.pending].map((batch) => batch.promise);
    if (pending.length > 0)
      yield* unwrap(Promise.allSettled(pending).then(() => undefined));
    this.throwIfCrashed();
  }
}
