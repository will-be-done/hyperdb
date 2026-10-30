import type { DBCmd } from "../commands/async";
import type { HyperDB, HyperDBTx } from "../core/contracts";
import type { Row, Trait } from "../core/primitives";
import { deepFreeze } from "../deep-freeze";
import type { Op } from "../runtime/ops";
import type { SubscribableDB } from "../runtime/subscribable-db";
import type { AnyTableDefinition, TableDefinition } from "../schema/table";
import { normalizeRecordForDriver } from "../storage/codec";
import {
  isUndoReplay,
  replayUndoType,
  runInUndoScope,
  skipUndoType,
  undoGroupType,
  type UndoTrait,
} from "./scope";
import { copyRow, equalValues } from "./values";

export type UndoRowChange = {
  readonly type: Op["type"];
  readonly table: AnyTableDefinition;
  readonly id: string;
  readonly before: Readonly<Row> | undefined;
  readonly after: Readonly<Row> | undefined;
};

export type UndoEvent = {
  readonly name?: string;
  readonly changes: readonly UndoRowChange[];
};

export type UndoStore = {
  readonly undoQueue: readonly UndoEvent[];
  readonly redoQueue: readonly UndoEvent[];
};

export type UndoOptions = {
  /** Domain tables to restore. Leave hook-maintained derived tables out. */
  tables: readonly AnyTableDefinition[];
  maxUndoLevels?: number;
  maxRedoLevels?: number;
};

export type UndoGroup = {
  /** Only synchronous work through the provided DB joins the group. */
  continue<T>(body: (db: HyperDB) => T): T;
  end(): void;
};

type GroupState = {
  name?: string;
  changes: RecordedChange[];
  closed: boolean;
};

type CapturedChange = {
  change: RecordedChange;
  group?: object;
};

type RecordedChange = UndoRowChange & { batch: object };
type HistoryEvent = { name?: string; changes: RecordedChange[] };

export class UndoConflictError extends Error {
  readonly tableName: string;
  readonly rowId: string;

  constructor(tableName: string, rowId: string) {
    super(`Undo/redo conflict in table "${tableName}" for row "${rowId}"`);
    this.name = "UndoConflictError";
    this.tableName = tableName;
    this.rowId = rowId;
  }
}

function levelLimit(value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("History limits must be non-negative safe integers");
  }
  return value;
}

function snapshotEvent(event: UndoEvent): UndoEvent {
  return Object.freeze({
    ...event,
    changes: Object.freeze(
      event.changes.map((change) =>
        Object.freeze({
          type: change.type,
          table: change.table,
          id: change.id,
          before: deepFreeze(copyRow(change.before)),
          after: deepFreeze(copyRow(change.after)),
        }),
      ),
    ),
  });
}

// Keep operation order for replay (including intermediate unique-index values),
// but don't create a history entry for a transaction whose net effect is empty.
function hasChanges(changes: readonly UndoRowChange[]): boolean {
  const rows = new Map<
    string,
    Map<string, { before: Row | undefined; after: Row | undefined }>
  >();
  for (const change of changes) {
    let table = rows.get(change.table.tableName);
    if (!table) rows.set(change.table.tableName, (table = new Map()));
    const previous = table.get(change.id);
    // A skipped write between recorded writes breaks continuity. Keep the
    // entry so replay reports a conflict rather than erasing excluded data.
    if (previous && !equalValues(previous.after, change.before)) return true;
    table.set(change.id, {
      before: previous ? previous.before : change.before,
      after: change.after,
    });
  }
  return [...rows.values()].some((table) =>
    [...table.values()].some((row) => !equalValues(row.before, row.after)),
  );
}

/** In-memory transaction history. Create with undoMiddleware(). */
export class UndoManager {
  readonly store: UndoStore;
  private readonly db: SubscribableDB;
  private readonly id = {};
  private readonly tables: Set<string>;
  private readonly maxUndo: number;
  private readonly maxRedo: number;
  private readonly captured = new WeakMap<Op, CapturedChange>();
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[];
  private undoStack: HistoryEvent[] = [];
  private redoStack: HistoryEvent[] = [];
  private openGroup?: GroupState;
  private activeGroup?: GroupState;
  private disposed = false;
  private busy = false;
  private revision = 0;
  private editRevision = 0;

  constructor(db: SubscribableDB, options: UndoOptions) {
    this.db = db;
    this.tables = new Set(options.tables.map((table) => table.tableName));
    this.maxUndo = levelLimit(options.maxUndoLevels);
    this.maxRedo = levelLimit(options.maxRedoLevels);
    const getUndo = () => this.undoQueue;
    const getRedo = () => this.redoQueue;
    this.store = Object.freeze({
      get undoQueue() {
        return getUndo();
      },
      get redoQueue() {
        return getRedo();
      },
    });
    const capture = this.capture.bind(this);
    this.off = [
      db.afterChange(function* (tx, table, traits, ops) {
        capture(tx, table, traits, ops);
      }),
      db.subscribe((ops) => this.record(ops)),
    ];
  }

  get undoQueue(): readonly UndoEvent[] {
    return Object.freeze(this.undoStack.map(snapshotEvent));
  }

  get redoQueue(): readonly UndoEvent[] {
    return Object.freeze(this.redoStack.map(snapshotEvent));
  }

  get undoLevels(): number {
    return this.undoStack.length;
  }
  get redoLevels(): number {
    return this.redoStack.length;
  }
  get canUndo(): boolean {
    return this.undoLevels > 0;
  }
  get canRedo(): boolean {
    return this.redoLevels > 0;
  }

  /** A stable primitive snapshot for useSyncExternalStore and similar adapters. */
  getRevision(): number {
    return this.revision;
  }

  subscribe(listener: () => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  *undo(): Generator<DBCmd, void> {
    yield* this.replay("undo");
  }
  *redo(): Generator<DBCmd, void> {
    yield* this.replay("redo");
  }

  clearUndo(): void {
    this.assertIdle();
    if (this.undoStack.length === 0) return;
    this.undoStack = [];
    this.notify();
  }

  clearRedo(): void {
    this.assertIdle();
    if (this.redoStack.length === 0) return;
    this.redoStack = [];
    this.notify();
  }

  withoutUndo<T>(
    body: () => Generator<unknown, T, unknown>,
  ): Generator<unknown, T, unknown>;
  withoutUndo<T>(body: (db: HyperDB) => T): T;
  withoutUndo<T>(
    body: (db: HyperDB) => T | Generator<unknown, T, unknown>,
  ): T | Generator<unknown, T, unknown> {
    this.assertUsable();
    const trait: UndoTrait = { type: skipUndoType, manager: this.id };
    // Generator functions and ordinary zero-argument generator factories both
    // work: invoke once with the scoped view, then inspect the returned value.
    const result = body(this.db.withTraits(trait));
    if (isGenerator<T>(result)) return runInUndoScope(() => result, trait);
    return result;
  }

  withGroup<T>(body: (db: HyperDB) => T): T;
  withGroup<T>(name: string, body: (db: HyperDB) => T): T;
  withGroup<T>(
    nameOrBody: string | ((db: HyperDB) => T),
    body?: (db: HyperDB) => T,
  ): T {
    const name = typeof nameOrBody === "string" ? nameOrBody : undefined;
    const fn = typeof nameOrBody === "function" ? nameOrBody : body!;
    if (this.activeGroup) return this.continueGroup(this.activeGroup, fn);
    const group = this.createGroup(name);
    try {
      return group.continue(fn);
    } finally {
      group.end();
    }
  }

  createGroup(name?: string): UndoGroup {
    this.assertIdle();
    const state: GroupState = { name, changes: [], closed: false };
    this.openGroup = state;
    return {
      continue: <T>(body: (db: HyperDB) => T) =>
        this.continueGroup(state, body),
      end: () => {
        if (state.closed) return;
        this.assertUsable();
        this.finishGroup(state);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.busy || this.activeGroup)
      throw new Error("Cannot dispose history while it is executing");
    if (this.openGroup) this.finishGroup(this.openGroup);
    this.disposed = true;
    for (const off of this.off) off();
    this.listeners.clear();
  }

  private capture(
    tx: HyperDB,
    table: TableDefinition,
    traits: Trait[],
    ops: Op[],
  ): void {
    if (!this.tables.has(table.tableName) || isUndoReplay(traits)) return;
    const scopes = traits as UndoTrait[];
    if (
      scopes.some(
        (trait) =>
          trait.type === skipUndoType &&
          (trait.manager === undefined || trait.manager === this.id),
      )
    )
      return;
    const group = scopes.findLast(
      (trait) => trait.type === undoGroupType && trait.manager === this.id,
    )?.group;
    const options = tx.getOptions!();
    const snapshot = (row: Row | undefined) =>
      row === undefined
        ? undefined
        : copyRow(normalizeRecordForDriver(table, row, options));
    const batch = {};
    for (const op of ops) {
      const before = snapshot(op.type === "insert" ? undefined : op.oldValue);
      const after = snapshot(op.type === "delete" ? undefined : op.newValue);
      this.captured.set(op, {
        change: {
          batch,
          type: op.type,
          table,
          id: (after ?? before)!.id,
          before,
          after,
        },
        group,
      });
    }
  }

  private record(ops: Op[]): void {
    const captured = ops.flatMap((op) => {
      const entry = this.captured.get(op);
      this.captured.delete(op);
      return entry ? [entry] : [];
    });
    const changes = captured.map((entry) => entry.change);
    if (!hasChanges(changes)) return;
    this.editRevision++;

    const group = this.openGroup;
    if (group && captured.every((entry) => entry.group === group)) {
      group.changes.push(...changes);
      this.notify();
      return;
    }
    // An unrelated recorded edit closes the pending group at its chronological
    // position. A later continue() cannot reorder that edit into the group.
    if (group) this.finishGroup(group);
    this.redoStack = [];
    this.push(this.undoStack, { changes }, this.maxUndo);
    this.notify();
  }

  private continueGroup<T>(group: GroupState, body: (db: HyperDB) => T): T {
    this.assertUsable();
    if (this.busy || group.closed || this.openGroup !== group) {
      throw new Error("Undo group is closed or history is executing");
    }
    const previous = this.activeGroup;
    this.activeGroup = group;
    try {
      const result = body(
        this.db.withTraits({
          type: undoGroupType,
          manager: this.id,
          group,
        } as UndoTrait),
      );
      if (
        isGenerator(result) ||
        (result && typeof (result as { then?: unknown }).then === "function")
      ) {
        throw new Error(
          "Undo group blocks must be synchronous; await between group.continue() calls",
        );
      }
      return result;
    } finally {
      this.activeGroup = previous;
    }
  }

  private finishGroup(group: GroupState): void {
    group.closed = true;
    this.openGroup = undefined;
    if (hasChanges(group.changes)) {
      this.redoStack = [];
      this.push(
        this.undoStack,
        { name: group.name, changes: group.changes },
        this.maxUndo,
      );
    }
    this.notify();
  }

  private *replay(direction: "undo" | "redo"): Generator<DBCmd, void> {
    this.assertIdle();
    this.busy = true;
    let tx: HyperDBTx | undefined;
    let committed = false;
    let failed = false;
    try {
      tx = yield* this.db
        .withTraits({
          type: replayUndoType,
          manager: this.id,
          direction,
        } as UndoTrait)
        .beginTx();
      const source = direction === "undo" ? this.undoStack : this.redoStack;
      const target = direction === "undo" ? this.redoStack : this.undoStack;
      const entry = source.at(-1);
      if (!entry) throw new Error(`Nothing to ${direction}`);
      const editRevision = this.editRevision;
      const plan =
        direction === "undo" ? [...entry.changes].reverse() : entry.changes;
      const expected = (change: UndoRowChange) =>
        direction === "undo" ? change.after : change.before;
      const desired = (change: UndoRowChange) =>
        direction === "undo" ? change.before : change.after;

      // Validate the whole plan before writing, simulating repeated row writes.
      const virtual = new Map<string, Map<string, Row | undefined>>();
      for (const change of plan) {
        let table = virtual.get(change.table.tableName);
        if (!table) virtual.set(change.table.tableName, (table = new Map()));
        const current = table.has(change.id)
          ? table.get(change.id)
          : yield* readRow(tx, change);
        if (!equalValues(current, expected(change))) {
          throw new UndoConflictError(change.table.tableName, change.id);
        }
        table.set(change.id, desired(change));
      }

      for (let start = 0; start < plan.length; ) {
        let end = start + 1;
        while (end < plan.length && plan[end].batch === plan[start].batch)
          end++;
        yield* applyBatch(tx, plan.slice(start, end), direction);
        start = end;
      }
      // Hooks may derive untracked data, but must not alter replayed domain rows.
      for (const [tableName, rows] of virtual) {
        const table = plan.find(
          (change) => change.table.tableName === tableName,
        )!.table;
        for (const [id, row] of rows) {
          if (!equalValues(yield* readRow(tx, { table, id }), row)) {
            throw new UndoConflictError(tableName, id);
          }
        }
      }
      yield* tx.commit();
      committed = true;
      const index = source.indexOf(entry);
      if (index !== -1) source.splice(index, 1);
      // A reentrant subscriber may have made a new edit after the replay commit.
      // Preserve that branch rather than adding stale redo history.
      if (this.editRevision === editRevision) {
        this.push(
          target,
          entry,
          direction === "undo" ? this.maxRedo : this.maxUndo,
        );
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (tx && !committed) {
          if (failed) {
            try {
              yield* tx.rollback();
            } catch {
              // Some runtimes finish a failed commit. Preserve the original error.
            }
          } else {
            yield* tx.rollback();
          }
        }
      } finally {
        this.busy = false;
      }
    }
    this.notify();
  }

  private push(
    stack: HistoryEvent[],
    event: HistoryEvent,
    limit: number,
  ): void {
    stack.push(event);
    if (stack.length > limit) stack.splice(0, stack.length - limit);
  }

  private notify(): void {
    this.revision++;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Undo manager is disposed");
  }

  private assertIdle(): void {
    this.assertUsable();
    if (this.busy) throw new Error("Undo manager is already executing");
    if (this.openGroup) throw new Error("End the open undo group first");
  }
}

function* readRow(
  tx: HyperDBTx,
  change: Pick<UndoRowChange, "table" | "id">,
): Generator<DBCmd, Row | undefined> {
  return (yield* tx.intervalScan(change.table, change.table.idIndexName, [
    { eq: [{ col: "id", val: change.id }] },
  ]))[0];
}

function* applyBatch(
  tx: HyperDBTx,
  changes: RecordedChange[],
  direction: "undo" | "redo",
): Generator<DBCmd, void> {
  const { table, type } = changes[0];
  if (direction === "redo") {
    if (type === "delete")
      yield* tx.delete(
        table,
        changes.map((change) => change.id),
      );
    else if (type === "insert")
      yield* tx.insert(
        table,
        changes.map((change) => copyRow(change.after)!),
      );
    else
      yield* tx.upsert(
        table,
        changes.map((change) => copyRow(change.after)!),
      );
  } else if (type === "insert") {
    yield* tx.delete(
      table,
      changes.map((change) => change.id),
    );
  } else if (type === "delete") {
    yield* tx.insert(
      table,
      changes.map((change) => copyRow(change.before)!),
    );
  } else {
    // Preserve upsert batches: restoring swapped unique keys one row at a time
    // would fail even though the original batch was valid.
    const inserted = changes.filter((change) => change.before === undefined);
    const replaced = changes.filter((change) => change.before !== undefined);
    if (inserted.length)
      yield* tx.delete(
        table,
        inserted.map((change) => change.id),
      );
    if (replaced.length)
      yield* tx.upsert(
        table,
        replaced.map((change) => copyRow(change.before)!),
      );
  }
}

function isGenerator<T>(
  value: unknown,
): value is Generator<unknown, T, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Generator).next === "function" &&
    typeof (value as Generator).throw === "function"
  );
}

export function undoMiddleware(
  db: SubscribableDB,
  options: UndoOptions,
): UndoManager {
  return new UndoManager(db, options);
}
