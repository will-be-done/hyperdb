import type { DBCmd } from "../commands/async";
import { unwrap } from "../commands/async";
import type { HyperDB } from "../core/contracts";
import { execAsync } from "../core/executor";
import type { Row } from "../core/primitives";
import type { TableDefinition } from "../schema/table";

/**
 * Thrown by every HybridDB read/write once background persistence has
 * permanently failed (all retries exhausted). The HybridDB is considered
 * crashed: its cache and primary may have diverged, so it refuses all further
 * operations rather than serving stale in-memory data. The underlying
 * persistence error is available via `cause`.
 */
export class HybridDBCrashedError extends Error {
  constructor(cause: unknown) {
    super(
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
    tableWrites.set(write.id, write);
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
    const upserts = coalescedWrites.filter(
      (write): write is HybridPendingWrite & { newValue: Row } =>
        write.newValue !== undefined,
    );
    const deletes = coalescedWrites.filter(
      (write) => write.newValue === undefined,
    );

    for (const [table, tableWrites] of groupByTable(
      upserts,
      (write) => write.table,
    )) {
      yield* tx.upsert(
        table,
        tableWrites.map((write) => write.newValue),
      );
    }

    for (const [table, tableWrites] of groupByTable(
      deletes,
      (write) => write.table,
    )) {
      yield* tx.delete(
        table,
        tableWrites.map((write) => write.id),
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
  readonly pending = new Set<HybridPersistenceBatch>();
  private tail = Promise.resolve();
  private nextBatchId = 1;
  isCrashed = false;
  private crashError: unknown;

  throwIfCrashed(): void {
    if (this.isCrashed) throw new HybridDBCrashedError(this.crashError);
  }

  enqueue(
    primary: HyperDB,
    writes: HybridPendingWrite[],
    onFailure?: (batchId: number, failure: HybridPersistenceFailure) => void,
  ): void {
    this.throwIfCrashed();
    if (writes.length === 0) return;
    const batchId = this.nextBatchId++;
    const persistWithRetry = (attempt: number): Promise<void> =>
      execAsync(persistWrites(primary, writes)).catch((error) => {
        const willRetry = attempt < hybridPersistenceMaxAttempts;
        const retryDelayMs = persistenceRetryDelayMs(attempt);
        onFailure?.(batchId, {
          error,
          attempt,
          maxAttempts: hybridPersistenceMaxAttempts,
          retryDelayMs: willRetry ? retryDelayMs : undefined,
          willRetry,
        });
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
      this.throwIfCrashed();
      return persistWithRetry(1);
    });
    const batch = { id: batchId, writes, promise };
    this.pending.add(batch);
    this.tail = promise.catch(() => {});
    void promise.then(
      () => {
        this.pending.delete(batch);
      },
      () => {
        this.pending.delete(batch);
      },
    );
  }

  *waitForPersistence(): Generator<DBCmd, void> {
    this.throwIfCrashed();
    const pending = [...this.pending].map((batch) => batch.promise);
    if (pending.length > 0)
      yield* unwrap(Promise.allSettled(pending).then(() => undefined));
    this.throwIfCrashed();
  }
}
