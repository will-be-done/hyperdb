import type { QueryWhereClause } from "../commands/query/commands";
import type { TupleScanOptions } from "../core/primitives";
import { DB } from "../runtime/db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { SyncDB } from "../runtime/sync-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import {
  defineTable,
  type ExtractIndexes,
  type ExtractSchema,
  type TableDefinition,
} from "../schema/table";
import { v } from "../schema/values";
import {
  setDefaultHyperDBTracer,
  type HyperDBTracer,
  type MutationEvent,
  type MutationEventKind,
  type MutationTraceInput,
  type MutationTracePatch,
  type RootTrace,
  type SelectTraceInput,
  type SelectCommandEvent,
  type TraceContext,
  type TraceError,
  type TraceFrame,
  type TraceFrameMeta,
  type TraceStatus,
} from "../core/tracer";
export {
  anonymousTraceMeta,
  createTraceFrameMeta,
} from "../core/tracer";
export type {
  CommandEventKind,
  MutationEvent,
  MutationEventKind,
  RootTrace,
  SelectCommandEvent,
  SerializableTraceValue,
  TraceContext,
  TraceError,
  TraceFrame,
  TraceFrameMeta,
  TraceKind,
  TraceStatus,
} from "../core/tracer";

export type SerializedValue = {
  text: string;
  value: unknown;
};

type TraceListener = () => void;

const traceRootsTable = defineTable("hyperdbTraceRoots", {
  id: v.string(),
  dbId: v.optional(v.string()),
  dbLabel: v.optional(v.string()),
  kind: v.union(v.literal("action"), v.literal("selector"), v.literal("unknown")),
  name: v.string(),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: v.union(v.literal("running"), v.literal("success"), v.literal("error")),
  createdSeq: v.number(),
})
  .index("byCreatedSeq", ["createdSeq"])
  .index("byDbCreatedSeq", ["dbId", "createdSeq"])
  .index("byStatusCreatedSeq", ["status", "createdSeq"])
  .index("byKindCreatedSeq", ["kind", "createdSeq"])
  .index("byStartedAt", ["startedAt"]);

type TraceRootRow = ExtractSchema<typeof traceRootsTable>;
const traceRootsRuntimeTable = traceRootsTable as TableDefinition<
  TraceRootRow,
  ExtractIndexes<typeof traceRootsTable>,
  unknown
>;

const traceMetaTable = defineTable("hyperdbTraceMeta", {
  id: v.string(),
  revision: v.number(),
});

type TraceMetaRow = ExtractSchema<typeof traceMetaTable>;
export const traceMetaRuntimeTable = traceMetaTable as unknown as TableDefinition<
  TraceMetaRow,
  ExtractIndexes<typeof traceMetaTable>
>;

export const traceMetaId = "trace-meta";

let idCounter = 0;
let dbCounter = 0;
const dbIds = new WeakMap<object, string>();
const dbLabels = new Map<string, string>();

type TraceDBIdentified = {
  getId?: () => string;
};

type TraceDBConfigured = {
  getTraceEnabled?: () => boolean;
  getAutoTraceEnabled?: () => boolean;
};

const isTraceEnabledForDB = (db: object | undefined): boolean =>
  ((db as TraceDBConfigured | undefined)?.getTraceEnabled?.() ?? false) ===
  true;

const isAutoTraceEnabledForDB = (db: object | undefined): boolean =>
  ((db as TraceDBConfigured | undefined)?.getAutoTraceEnabled?.() ?? true) ===
  true;

const nextId = (prefix: string): string => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const wallClockNow = (): number => Date.now();

export const summarizeError = (error: unknown): TraceError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === "string" ? error : safeSerialize(error).text,
  };
};

export type TraceDBInfo = {
  id: string;
  label: string;
};

export const getTraceDBInfo = (db: object): TraceDBInfo => {
  const explicitId = (db as TraceDBIdentified).getId?.();

  if (explicitId) {
    if (!dbLabels.has(explicitId)) {
      dbCounter += 1;
      dbLabels.set(explicitId, `DB ${dbCounter}`);
    }

    return {
      id: explicitId,
      label: dbLabels.get(explicitId) ?? explicitId,
    };
  }

  let id = dbIds.get(db);

  if (!id) {
    dbCounter += 1;
    id = `db-${dbCounter}`;
    dbIds.set(db, id);
    dbLabels.set(id, `DB ${dbCounter}`);
  }

  return {
    id,
    label: dbLabels.get(id) ?? id,
  };
};

export const safeSerialize = (value: unknown): SerializedValue => {
  const seen = new WeakSet<object>();

  try {
    const json = JSON.stringify(
      value,
      (_key, currentValue: unknown) => {
        if (typeof currentValue === "bigint") {
          return `${currentValue.toString()}n`;
        }

        if (typeof currentValue === "function") {
          return `[Function ${(currentValue as { name?: string }).name || "anonymous"}]`;
        }

        if (typeof currentValue === "symbol") {
          return String(currentValue);
        }

        if (typeof currentValue === "object" && currentValue !== null) {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }
          seen.add(currentValue);
        }

        return currentValue;
      },
      2,
    );

    return { text: json ?? String(value), value };
  } catch (error) {
    return {
      text: `[Unserializable: ${summarizeError(error).message}]`,
      value,
    };
  }
};

const omitUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const next: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue !== undefined) {
      next[key] = fieldValue;
    }
  }
  return next as T;
};

export class HyperDBTraceStore implements HyperDBTracer {
  private subDb = new SubscribableDB(
    new DB(new BptreeInmemDriver(), {
      autoTrace: false,
      tracer: null,
    }),
  );
  private db = new SyncDB(this.subDb);
  private snapshot: RootTrace[] = [];
  private payloads = new Map<string, RootTrace>();
  private createdSeqByTraceId = new Map<string, number>();
  private listeners = new Set<TraceListener>();
  private activeListenerCount = 0;
  private notifyQueued = false;
  private maxTraces: number;
  private createdSeq = 0;
  private revision = 0;

  constructor(maxTraces = 2000) {
    this.maxTraces = maxTraces;
    this.db.loadTables([traceRootsRuntimeTable, traceMetaRuntimeTable]);
    this.bumpRevision();
  }

  getDB = (): SubscribableDB => this.subDb;

  subscribe = (listener: TraceListener): (() => void) => {
    this.listeners.add(listener);
    this.activeListenerCount += 1;

    return () => {
      if (this.listeners.delete(listener)) {
        this.activeListenerCount -= 1;
      }
    };
  };

  getSnapshot = (): RootTrace[] => this.snapshot;

  getTraces = (
    maxTraces: number,
    kind?: "selector" | "action",
  ): RootTrace[] => {
    const n = Number(maxTraces);
    const limit = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;

    const rows =
      kind === undefined
        ? this.db.intervalScan(
            traceRootsRuntimeTable,
            "byCreatedSeq",
            [{}],
            { order: "desc", limit },
          )
        : this.db.intervalScan(
            traceRootsRuntimeTable,
            "byKindCreatedSeq",
            [{ eq: [{ col: "kind", val: kind }] }],
            { order: "desc", limit },
          );

    return rows
      .map((row) => this.payloads.get(row.id))
      .filter((trace): trace is RootTrace => trace !== undefined);
  };

  getListenerCount = (): number => this.activeListenerCount;

  isActive = (): boolean => this.activeListenerCount > 0;

  setMaxTraces = (maxTraces: number): void => {
    const n = Number(maxTraces);
    if (!Number.isFinite(n)) return;

    const nextMaxTraces = Math.max(1, Math.floor(n));
    if (nextMaxTraces === this.maxTraces) return;

    this.maxTraces = nextMaxTraces;
    this.trim();
    this.refreshSnapshot();
    this.notify();
  };

  clear = (): void => {
    const ids = [...this.payloads.keys()];
    if (ids.length > 0) {
      this.db.delete(traceRootsRuntimeTable, ids);
    }
    this.payloads.clear();
    this.createdSeqByTraceId.clear();
    this.refreshSnapshot();
    this.notify();
  };

  clearDB = (dbId: string | undefined): void => {
    const rows =
      dbId === undefined
        ? this.allRows().filter((row) => row.dbId === undefined)
        : this.db.intervalScan(
            traceRootsRuntimeTable,
            "byDbCreatedSeq",
            [{ eq: [{ col: "dbId", val: dbId }] }],
          );
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    this.db.delete(traceRootsRuntimeTable, ids);
    for (const id of ids) {
      this.payloads.delete(id);
      this.createdSeqByTraceId.delete(id);
    }
    this.refreshSnapshot();
    this.notify();
  };

  addTrace = (trace: RootTrace): void => {
    this.createdSeq += 1;
    this.createdSeqByTraceId.set(trace.id, this.createdSeq);
    this.payloads.set(trace.id, trace);
    this.db.upsert(traceRootsRuntimeTable, [this.rowFromTrace(trace)]);
    this.trim();
    this.refreshSnapshot();
    this.notify();
  };

  updateTrace = (trace: RootTrace): void => {
    if (!this.payloads.has(trace.id)) return;
    this.db.upsert(traceRootsRuntimeTable, [this.rowFromTrace(trace)]);
    this.payloads.set(trace.id, trace);
    this.refreshSnapshot();
  };

  startRootTrace = (
    meta: TraceFrameMeta,
    db?: object,
  ): TraceContext | undefined => startRootTrace(meta, this, db);

  enterFramePath = (
    context: TraceContext,
    path: TraceFrameMeta[] | undefined,
  ): TraceFrame => enterFramePath(context, path);

  getCurrentTraceFrame = (context: TraceContext): TraceFrame =>
    getCurrentTraceFrame(context);

  getCurrentTraceFrameMeta = (context: TraceContext): TraceFrameMeta =>
    getCurrentTraceFrameMeta(context);

  markTraceFrameCached = (
    context: TraceContext,
    frame: TraceFrame,
  ): void => markTraceFrameCached(context, frame);

  endTraceSuccess = (context: TraceContext): void => endTraceSuccess(context);

  endTraceError = (context: TraceContext, error: unknown): void =>
    endTraceError(context, error);

  beginSelectEvent = (
    context: TraceContext,
    frame: TraceFrame,
    input: SelectTraceInput,
  ): SelectCommandEvent => beginSelectEvent(context, frame, input);

  endSelectEventSuccess = (
    context: TraceContext,
    event: SelectCommandEvent,
    result: unknown[],
  ): void => endSelectEventSuccess(context, event, result);

  endSelectEventError = (
    context: TraceContext,
    event: SelectCommandEvent,
    error: unknown,
  ): void => endSelectEventError(context, event, error);

  beginMutationEvent = (
    context: TraceContext,
    frame: TraceFrame,
    input: MutationTraceInput,
  ): MutationEvent => beginMutationEvent(context, frame, input);

  endMutationEventSuccess = (
    context: TraceContext,
    event: MutationEvent,
    patch: MutationTracePatch = {},
  ): void => endMutationEventSuccess(context, event, patch);

  endMutationEventError = (
    context: TraceContext,
    event: MutationEvent,
    error: unknown,
  ): void => endMutationEventError(context, event, error);

  notify = (): void => {
    if (this.notifyQueued) return;

    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.bumpRevision();

      for (const listener of [...this.listeners]) {
        listener();
      }
    });
  };

  private bumpRevision(): void {
    this.revision += 1;
    this.db.upsert(traceMetaTable, [
      {
        id: traceMetaId,
        revision: this.revision,
      },
    ]);
  }

  private trim(): void {
    const rows = this.allRows();
    if (rows.length <= this.maxTraces) return;

    const ids = rows.slice(this.maxTraces).map((row) => row.id);
    this.db.delete(traceRootsRuntimeTable, ids);
    for (const id of ids) {
      this.payloads.delete(id);
      this.createdSeqByTraceId.delete(id);
    }
  }

  private allRows(): TraceRootRow[] {
    return this.db.intervalScan(
      traceRootsRuntimeTable,
      "byCreatedSeq",
      [{}],
      { order: "desc" },
    );
  }

  private refreshSnapshot(): void {
    this.snapshot = this.db
      .intervalScan(
        traceRootsRuntimeTable,
        "byCreatedSeq",
        [{}],
        { order: "desc", limit: this.maxTraces },
      )
      .map((row) => this.payloads.get(row.id))
      .filter((trace): trace is RootTrace => trace !== undefined);
  }

  private rowFromTrace(trace: RootTrace): TraceRootRow {
    return omitUndefined({
      id: trace.id,
      dbId: trace.dbId,
      dbLabel: trace.dbLabel,
      kind: trace.kind,
      name: trace.name,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      durationMs: trace.durationMs,
      status: trace.status,
      createdSeq: this.createdSeqByTraceId.get(trace.id) ?? 0,
    });
  }
}

export const hyperDBTraceStore = new HyperDBTraceStore();
setDefaultHyperDBTracer(hyperDBTraceStore);

const createFrame = (
  meta: TraceFrameMeta,
  startedAt: number,
  parentId?: string,
): TraceFrame => ({
  id: nextId("frame"),
  parentId,
  kind: meta.kind,
  name: meta.name,
  arg: meta.arg,
  startedAt,
  status: "running",
  children: [],
  commandIds: [],
  mutationIds: [],
});

const finishDuration = (startedAt: number): number =>
  Math.max(0, wallClockNow() - startedAt);

const finishFrame = (
  frame: TraceFrame,
  status: Exclude<TraceStatus, "running">,
  error?: unknown,
): void => {
  if (frame.status !== "running") return;
  frame.endedAt = wallClockNow();
  frame.durationMs = finishDuration(frame.startedAt);
  frame.status = status;
  if (error !== undefined) {
    frame.error = summarizeError(error);
  }
};

export const startRootTrace = (
  meta: TraceFrameMeta,
  store = hyperDBTraceStore,
  db?: object,
): TraceContext | undefined => {
  if (meta.skipRootTrace) return undefined;

  if (
    !isTraceEnabledForDB(db) &&
    (!store.isActive() || !isAutoTraceEnabledForDB(db))
  ) {
    return undefined;
  }

  const startedAt = wallClockNow();
  const rootFrame = createFrame(meta, startedAt);
  const dbInfo = db ? getTraceDBInfo(db) : undefined;
  const trace: RootTrace = {
    id: nextId("trace"),
    dbId: dbInfo?.id,
    dbLabel: dbInfo?.label,
    kind: meta.kind,
    name: meta.name,
    arg: meta.arg,
    startedAt,
    status: "running",
    frames: [rootFrame],
    commandEvents: [],
    mutationEvents: [],
  };

  const context: TraceContext = {
    trace,
    rootFrame,
    frameStack: [rootFrame],
    frameMetas: [meta],
    rootMetaId: meta.id,
    store,
    tracer: store,
  };

  store.addTrace(trace);
  return context;
};

const sameMeta = (left: TraceFrameMeta, right: TraceFrameMeta): boolean =>
  left.id === right.id;

export const enterFramePath = (
  context: TraceContext,
  path: TraceFrameMeta[] | undefined,
): TraceFrame => {
  // yield* hides delegated generator boundaries from the runner. Child frames
  // therefore close when command ownership returns to an ancestor, or when the
  // root trace ends, which is the closest reliable timing available here.
  const normalizedPath =
    path && path.length > 0
      ? path[0]?.id === context.rootMetaId
        ? path
        : [context.frameMetas[0]!, ...path]
      : [context.frameMetas[0]!];

  let sharedLength = 0;
  while (
    sharedLength < context.frameMetas.length &&
    sharedLength < normalizedPath.length &&
    sameMeta(context.frameMetas[sharedLength]!, normalizedPath[sharedLength]!)
  ) {
    sharedLength += 1;
  }

  while (context.frameStack.length > sharedLength) {
    const frame = context.frameStack.pop()!;
    context.frameMetas.pop();
    finishFrame(frame, "success");
  }

  for (let i = sharedLength; i < normalizedPath.length; i++) {
    const meta = normalizedPath[i]!;
    const parent = context.frameStack[context.frameStack.length - 1]!;
    const frame = createFrame(meta, wallClockNow(), parent.id);
    parent.children.push(frame);
    context.frameStack.push(frame);
    context.frameMetas.push(meta);
  }

  return context.frameStack[context.frameStack.length - 1]!;
};

export const getCurrentTraceFrame = (context: TraceContext): TraceFrame =>
  context.frameStack[context.frameStack.length - 1]!;

export const getCurrentTraceFrameMeta = (
  context: TraceContext,
): TraceFrameMeta => context.frameMetas[context.frameMetas.length - 1]!;

export const markTraceFrameCached = (
  context: TraceContext,
  frame: TraceFrame,
): void => {
  frame.cached = true;
  context.store.notify();
};

export const recordCachedRootTrace = (
  meta: TraceFrameMeta,
  db?: object,
): void => {
  const context = startRootTrace(meta, hyperDBTraceStore, db);
  if (!context) return;

  markTraceFrameCached(context, context.rootFrame);
  endTraceSuccess(context);
};

export const endTraceSuccess = (context: TraceContext): void => {
  enterFramePath(context, undefined);
  finishFrame(context.rootFrame, "success");
  context.trace.endedAt = context.rootFrame.endedAt;
  context.trace.durationMs = context.rootFrame.durationMs;
  context.trace.status = "success";
  if (context.store instanceof HyperDBTraceStore) {
    context.store.updateTrace(context.trace);
  }
  context.store.notify();
};

export const endTraceError = (context: TraceContext, error: unknown): void => {
  while (context.frameStack.length > 0) {
    const frame = context.frameStack.pop()!;
    context.frameMetas.pop();
    finishFrame(frame, "error", error);
  }

  context.trace.endedAt = wallClockNow();
  context.trace.durationMs = finishDuration(context.trace.startedAt);
  context.trace.status = "error";
  context.trace.error = summarizeError(error);
  if (context.store instanceof HyperDBTraceStore) {
    context.store.updateTrace(context.trace);
  }
  context.store.notify();
};

export const beginSelectEvent = (
  context: TraceContext,
  frame: TraceFrame,
  input: {
    tableName: string;
    index: string;
    where: QueryWhereClause[];
    bounds: TupleScanOptions[];
    limit?: number;
    order?: SelectCommandEvent["order"];
  },
): SelectCommandEvent => {
  const event: SelectCommandEvent = {
    id: nextId("cmd"),
    frameId: frame.id,
    kind: "select",
    tableName: input.tableName,
    index: input.index,
    where: input.where,
    bounds: input.bounds,
    limit: input.limit,
    order: input.order,
    startedAt: wallClockNow(),
    status: "running",
  };
  frame.commandIds.push(event.id);
  context.trace.commandEvents.push(event);
  context.store.notify();
  return event;
};

export const endSelectEventSuccess = (
  context: TraceContext,
  event: SelectCommandEvent,
  result: unknown[],
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.resultCount = result.length;
  event.result = result;
  event.status = "success";
  context.store.notify();
};

export const endSelectEventError = (
  context: TraceContext,
  event: SelectCommandEvent,
  error: unknown,
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "error";
  event.error = summarizeError(error);
  context.store.notify();
};

export const beginMutationEvent = (
  context: TraceContext,
  frame: TraceFrame,
  input: {
    kind: MutationEventKind;
    tableName: string;
    rows?: unknown[];
    ids?: string[];
    oldValue?: unknown[];
    newValue?: unknown[];
  },
): MutationEvent => {
  const event: MutationEvent = {
    id: nextId("mutation"),
    frameId: frame.id,
    kind: input.kind,
    tableName: input.tableName,
    rows: input.rows,
    ids: input.ids,
    oldValue: input.oldValue,
    newValue: input.newValue,
    startedAt: wallClockNow(),
    status: "running",
  };
  frame.mutationIds.push(event.id);
  context.trace.mutationEvents.push(event);
  context.store.notify();
  return event;
};

export const endMutationEventSuccess = (
  context: TraceContext,
  event: MutationEvent,
  patch: Partial<
    Pick<MutationEvent, "rows" | "ids" | "oldValue" | "newValue">
  > = {},
): void => {
  Object.assign(event, patch);
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "success";
  context.store.notify();
};

export const endMutationEventError = (
  context: TraceContext,
  event: MutationEvent,
  error: unknown,
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "error";
  event.error = summarizeError(error);
  context.store.notify();
};
