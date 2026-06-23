export type PersistenceSnapshot = {
  /** Queued batches not yet written to IndexedDB. */
  pendingBatches: number;
  /** Total ops across all queued batches. */
  pendingOps: number;
  /** A batch is currently being written. */
  draining: boolean;
  /** Wall-clock time of the most recent persisted batch, in ms. */
  lastDurationMs: number | null;
  /** Op count of the most recent persisted batch. */
  lastOpCount: number | null;
  /** Total ops persisted since startup. */
  totalPersisted: number;
};

const INITIAL: PersistenceSnapshot = {
  pendingBatches: 0,
  pendingOps: 0,
  draining: false,
  lastDurationMs: null,
  lastOpCount: null,
  totalPersisted: 0,
};

/**
 * A tiny observable describing the IndexedDB persistence loop, shaped for
 * `useSyncExternalStore`: `getSnapshot` returns a stable object that only
 * changes identity when the state changes.
 */
export class PersistenceMonitor {
  private state: PersistenceSnapshot = INITIAL;
  private listeners = new Set<() => void>();

  getSnapshot = (): PersistenceSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** True while a batch is being written or work is still queued. */
  hasPendingWork(): boolean {
    return this.state.draining || this.state.pendingBatches > 0;
  }

  update(patch: Partial<PersistenceSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
