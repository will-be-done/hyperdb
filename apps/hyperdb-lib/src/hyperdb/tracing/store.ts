import type { QueryWhereClause } from "../commands/selector/commands";
import type { TupleScanOptions } from "../core/primitives";
import { DB } from "../runtime/db";
import { SubscribableDB } from "../runtime/subscribable-db";
import { SyncDB } from "../runtime/sync-db";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable, type ExtractSchema } from "../schema/table";
import { v, type Validator } from "../schema/values";
import {
  defaultTraceOptions,
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
  defaultTraceOptions,
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
  TraceOptions,
  TraceStatus,
} from "../core/tracer";

export type SerializedValue = {
  text: string;
  value: unknown;
};

export type TraceSortField = "created" | "duration";
export type TraceSortDir = "asc" | "desc";
export type TraceQueryKind = "selector" | "action";

export const unassignedTraceDBKey = "__hyperdb_unassigned__";

const traceCommitBatchMs = 50;

const normalizeMaxTraces = (maxTraces: number): number => {
  const n = Number(maxTraces);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1000;
};

const traceRootsTable = defineTable("hyperdbTraceRoots", {
  id: v.string(),
  dbId: v.optional(v.string()),
  dbKey: v.string(),
  dbLabel: v.optional(v.string()),
  kind: v.union(
    v.literal("action"),
    v.literal("selector"),
    v.literal("unknown"),
  ),
  name: v.string(),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: v.union(
    v.literal("running"),
    v.literal("success"),
    v.literal("error"),
  ),
  cached: v.boolean(),
  selectCount: v.number(),
  queriedRowCount: v.number(),
  hasPendingSelect: v.boolean(),
  actionCount: v.number(),
  mutatedRowCount: v.number(),
  createdSeq: v.number(),
})
  .index("byCreatedSeq", ["createdSeq"])
  .index("byDbCreatedSeq", ["dbId", "createdSeq"])
  .index("byStatusCreatedSeq", ["status", "createdSeq"])
  .index("byKindCreatedSeq", ["kind", "createdSeq"])
  .index("byStartedAt", ["startedAt"])
  .index("byDbStartedAt", ["dbKey", "startedAt"])
  .index("byDurationMs", ["durationMs"])
  .index("byDbDurationMs", ["dbKey", "durationMs"]);

export type TraceRootRow = ExtractSchema<typeof traceRootsTable>;
export const traceRootsRuntimeTable = traceRootsTable;

const traceKindValue = v.union(
  v.literal("action"),
  v.literal("selector"),
  v.literal("unknown"),
);

const traceStatusValue = v.union(
  v.literal("running"),
  v.literal("success"),
  v.literal("error"),
);

const traceErrorValue = v.object({
  name: v.optional(v.string()),
  message: v.string(),
  stack: v.optional(v.string()),
});

const selectCommandEventValue = v.object({
  id: v.string(),
  frameId: v.string(),
  kind: v.literal("select"),
  tableName: v.string(),
  index: v.string(),
  where: v.array(v.pass<QueryWhereClause>()),
  bounds: v.array(v.pass<TupleScanOptions>()),
  limit: v.optional(v.number()),
  order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  resultCount: v.optional(v.number()),
  result: v.optional(v.array(v.pass<unknown>())),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: traceStatusValue,
  error: v.optional(traceErrorValue),
}) satisfies Validator<SelectCommandEvent>;

const mutationEventValue = v.object({
  id: v.string(),
  frameId: v.string(),
  kind: v.union(v.literal("insert"), v.literal("upsert"), v.literal("delete")),
  tableName: v.string(),
  rows: v.optional(v.array(v.pass<unknown>())),
  ids: v.optional(v.array(v.string())),
  oldValue: v.optional(v.array(v.pass<unknown>())),
  newValue: v.optional(v.array(v.pass<unknown>())),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: traceStatusValue,
  error: v.optional(traceErrorValue),
}) satisfies Validator<MutationEvent>;

type StoredTraceFrame = Omit<TraceFrame, "arg" | "children"> & {
  arg?: unknown;
  children: StoredTraceFrame[];
};

type StoredRootTrace = Omit<RootTrace, "arg" | "frames"> & {
  arg?: unknown;
  frames: StoredTraceFrame[];
};

const traceFrameValue: Validator<StoredTraceFrame> = v.object({
  id: v.string(),
  parentId: v.optional(v.string()),
  kind: traceKindValue,
  name: v.string(),
  arg: v.optional(v.pass<unknown>()),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: traceStatusValue,
  error: v.optional(traceErrorValue),
  cached: v.optional(v.boolean()),
  children: v.array(v.lazy(() => traceFrameValue)),
  commandIds: v.array(v.string()),
  mutationIds: v.array(v.string()),
});

const rootTraceValue = v.object({
  id: v.string(),
  dbId: v.optional(v.string()),
  dbLabel: v.optional(v.string()),
  kind: traceKindValue,
  name: v.string(),
  arg: v.optional(v.pass<unknown>()),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  status: traceStatusValue,
  error: v.optional(traceErrorValue),
  frames: v.array(traceFrameValue),
  commandEvents: v.array(selectCommandEventValue),
  mutationEvents: v.array(mutationEventValue),
}) satisfies Validator<StoredRootTrace>;

const tracePayloadsTable = defineTable("hyperdbTracePayloads", {
  id: v.string(),
  trace: rootTraceValue,
});

export type TracePayloadRow = ExtractSchema<typeof tracePayloadsTable>;
export const tracePayloadsRuntimeTable = tracePayloadsTable;

const isPlainStorageObject = (
  value: object,
): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const safeStorageKey = (key: string): string =>
  key.length === 0 || key.startsWith("$") ? `_${key}` : key;

const sanitizeTraceData = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (value === undefined) return undefined;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") {
    return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceData(item, seen) ?? "[Undefined]");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (!isPlainStorageObject(value)) {
    return safeSerialize(value).text;
  }

  seen.add(value);
  try {
    const next: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      const sanitized = sanitizeTraceData(fieldValue, seen);
      if (sanitized !== undefined) {
        next[safeStorageKey(key)] = sanitized;
      }
    }
    return next;
  } finally {
    seen.delete(value);
  }
};

const storeTraceFrame = (frame: TraceFrame): StoredTraceFrame => {
  const sanitized = sanitizeTraceData(frame) as TraceFrame;
  return omitUndefined({
    ...sanitized,
    children: sanitized.children.map(storeTraceFrame),
  });
};

const storeTracePayload = (trace: RootTrace): StoredRootTrace => {
  const sanitized = sanitizeTraceData(trace) as RootTrace;
  return omitUndefined({
    ...sanitized,
    frames: sanitized.frames.map(storeTraceFrame),
  });
};

const hydrateTraceFrame = (frame: StoredTraceFrame): TraceFrame => ({
  ...frame,
  arg: frame.arg,
  children: frame.children.map(hydrateTraceFrame),
});

export const hydrateTracePayload = (trace: StoredRootTrace): RootTrace => ({
  ...trace,
  arg: trace.arg,
  frames: trace.frames.map(hydrateTraceFrame),
});

let idCounter = 0;
let dbCounter = 0;
const dbIds = new WeakMap<object, string>();
const dbLabels = new Map<string, string>();

type TraceDBIdentified = {
  getId?: () => string;
  getDBName?: () => string | undefined;
};

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
  const explicitName = (db as TraceDBIdentified).getDBName?.();

  if (explicitId) {
    if (explicitName) {
      dbLabels.set(explicitId, explicitName);
    }

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

const countActionFrames = (frame: TraceFrame): number =>
  (frame.kind === "action" ? 1 : 0) +
  frame.children.reduce((total, child) => total + countActionFrames(child), 0);

const mutationRecordCount = (event: MutationEvent): number | undefined => {
  if (event.rows !== undefined) return event.rows.length;
  if (event.newValue !== undefined) return event.newValue.length;
  if (event.ids !== undefined) return event.ids.length;
  if (event.oldValue !== undefined) return event.oldValue.length;
  return undefined;
};

const getTraceQueriedRowCount = (trace: RootTrace): number =>
  trace.commandEvents.reduce(
    (total, event) => total + (event.resultCount ?? 0),
    0,
  );

const hasPendingSelect = (trace: RootTrace): boolean =>
  trace.commandEvents.some(
    (event) => event.status === "running" && event.resultCount === undefined,
  );

const getTraceActionCount = (trace: RootTrace): number =>
  trace.frames.reduce((total, frame) => total + countActionFrames(frame), 0);

const getTraceMutatedRowCount = (trace: RootTrace): number =>
  trace.mutationEvents.reduce(
    (total, event) => total + (mutationRecordCount(event) ?? 0),
    0,
  );

export class HyperDBTraceStore implements HyperDBTracer {
  private subDb = new SubscribableDB(
    new DB(new BptreeInmemDriver(), {
      tracer: null,
    }),
  );
  private db = new SyncDB(this.subDb);
  private queuedTraces = new Map<string, RootTrace>();
  private createdSeqByTraceId = new Map<string, number>();
  private persistedTraceIds = new Set<string>();
  private activeActivationCount = 0;
  private commitTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private maxTraces: number;
  private createdSeq = 0;

  constructor(maxTraces = 1000) {
    this.maxTraces = normalizeMaxTraces(maxTraces);
    this.db.loadTables([traceRootsRuntimeTable, tracePayloadsRuntimeTable]);
  }

  getDB = (): SubscribableDB => this.subDb;

  resolveTraceRows = (rows: TraceRootRow[]): RootTrace[] => {
    return rows
      .map((row) => this.getTracePayload(row.id))
      .filter((trace): trace is RootTrace => trace !== undefined);
  };

  isActive = (): boolean => this.activeActivationCount > 0;

  activate = (): (() => void) => {
    this.activeActivationCount += 1;
    let active = true;

    return () => {
      if (!active) return;
      active = false;
      this.activeActivationCount -= 1;
    };
  };

  setMaxTraces = (maxTraces: number): void => {
    const n = Number(maxTraces);
    if (!Number.isFinite(n)) return;

    const nextMaxTraces = Math.max(1, Math.floor(n));
    if (nextMaxTraces === this.maxTraces) return;

    this.maxTraces = nextMaxTraces;
    this.trimQueued();
  };

  clear = (): void => {
    this.cancelScheduledFlush();
    this.queuedTraces.clear();
    const ids = this.allRows().map((row) => row.id);
    if (ids.length > 0) {
      this.deleteTraceRows(ids);
    }
    this.createdSeqByTraceId.clear();
    this.persistedTraceIds.clear();
  };

  clearDB = (dbId: string | undefined): void => {
    for (const [id, trace] of this.queuedTraces) {
      if (trace.dbId === dbId) {
        this.queuedTraces.delete(id);
        this.createdSeqByTraceId.delete(id);
      }
    }
    if (this.queuedTraces.size === 0) {
      this.cancelScheduledFlush();
    }

    const rows =
      dbId === undefined
        ? this.allRows().filter((row) => row.dbId === undefined)
        : this.db.intervalScan(traceRootsRuntimeTable, "byDbCreatedSeq", [
            { eq: [{ col: "dbId", val: dbId }] },
          ]);
    if (rows.length === 0) {
      return;
    }

    const ids = rows.map((row) => row.id);
    this.deleteTraceRows(ids);
    for (const id of ids) {
      this.createdSeqByTraceId.delete(id);
      this.persistedTraceIds.delete(id);
    }
  };

  addTrace = (trace: RootTrace): void => {
    this.createdSeq += 1;
    this.createdSeqByTraceId.set(trace.id, this.createdSeq);
    if (trace.status !== "running") {
      this.upsertTraceRows(trace);
      this.persistedTraceIds.add(trace.id);
    }
    this.trimPersisted();
  };

  updateTrace = (trace: RootTrace): void => {
    this.enqueueTrace(trace);
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

  markTraceFrameCached = (context: TraceContext, frame: TraceFrame): void =>
    markTraceFrameCached(context, frame);

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

  private trimPersisted(): void {
    const overflow = this.persistedTraceIds.size - this.maxTraces;
    if (overflow <= 0) return;

    const removedIds = this.db
      .intervalScan(traceRootsRuntimeTable, "byCreatedSeq", [{}], {
        limit: overflow,
        order: "asc",
      })
      .map((row) => row.id);

    if (removedIds.length === 0) return;

    this.deleteTraceRows(removedIds);
    for (const id of removedIds) {
      this.persistedTraceIds.delete(id);
      this.createdSeqByTraceId.delete(id);
    }
  }

  private enqueueTrace(trace: RootTrace): void {
    if (!this.createdSeqByTraceId.has(trace.id)) {
      this.createdSeq += 1;
      this.createdSeqByTraceId.set(trace.id, this.createdSeq);
    }

    this.queuedTraces.set(trace.id, trace);
    this.trimQueued();
    this.scheduleFlush();
  }

  private trimQueued(): void {
    while (this.queuedTraces.size > this.maxTraces) {
      const oldestQueuedId = this.queuedTraces.keys().next().value as
        | string
        | undefined;
      if (oldestQueuedId === undefined) return;
      this.queuedTraces.delete(oldestQueuedId);
      this.createdSeqByTraceId.delete(oldestQueuedId);
    }
  }

  private scheduleFlush(): void {
    if (this.commitTimer !== undefined) return;
    this.commitTimer = globalThis.setTimeout(() => {
      this.commitTimer = undefined;
      this.flushQueuedTraces();
    }, traceCommitBatchMs);
  }

  private cancelScheduledFlush(): void {
    if (this.commitTimer === undefined) return;
    globalThis.clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
  }

  private flushQueuedTraces(): void {
    const traces = [...this.queuedTraces.values()];
    if (traces.length === 0) return;

    this.queuedTraces.clear();

    const tx = this.db.beginTx();
    try {
      tx.upsert(
        traceRootsRuntimeTable,
        traces.map((trace) => this.rowFromTrace(trace)),
      );
      tx.upsert(
        tracePayloadsRuntimeTable,
        traces.map((trace) => this.payloadRowFromTrace(trace)),
      );
      tx.commit();
    } catch (error) {
      tx.rollback();
      for (const trace of traces) {
        this.queuedTraces.set(trace.id, trace);
      }
      this.scheduleFlush();
      throw error;
    }

    for (const trace of traces) {
      this.persistedTraceIds.add(trace.id);
    }
    this.trimPersisted();
  }

  private upsertTraceRows(trace: RootTrace): void {
    const tx = this.db.beginTx();

    try {
      tx.upsert(traceRootsRuntimeTable, [this.rowFromTrace(trace)]);
      tx.upsert(tracePayloadsRuntimeTable, [this.payloadRowFromTrace(trace)]);
      tx.commit();
    } catch (error) {
      tx.rollback();
      throw error;
    }
  }

  private deleteTraceRows(ids: string[]): void {
    const tx = this.db.beginTx();

    try {
      tx.delete(traceRootsRuntimeTable, ids);
      tx.delete(tracePayloadsRuntimeTable, ids);
      tx.commit();
    } catch (error) {
      tx.rollback();
      throw error;
    }
  }

  private allRows(): TraceRootRow[] {
    return this.db.intervalScan(traceRootsRuntimeTable, "byCreatedSeq", [{}], {
      order: "desc",
    });
  }

  private getTracePayload(id: string): RootTrace | undefined {
    const trace = this.db.intervalScan(tracePayloadsRuntimeTable, "byId", [
      { eq: [{ col: "id", val: id }] },
    ])[0]?.trace;

    return trace ? hydrateTracePayload(trace) : undefined;
  }

  private rowFromTrace(trace: RootTrace): TraceRootRow {
    return omitUndefined({
      id: trace.id,
      dbId: trace.dbId,
      dbKey: trace.dbId ?? unassignedTraceDBKey,
      dbLabel: trace.dbLabel,
      kind: trace.kind,
      name: trace.name,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      durationMs: trace.durationMs ?? 0,
      status: trace.status,
      cached: trace.frames[0]?.cached === true,
      selectCount: trace.commandEvents.length,
      queriedRowCount: getTraceQueriedRowCount(trace),
      hasPendingSelect: hasPendingSelect(trace),
      actionCount: getTraceActionCount(trace),
      mutatedRowCount: getTraceMutatedRowCount(trace),
      createdSeq: this.createdSeqByTraceId.get(trace.id) ?? 0,
    });
  }

  private payloadRowFromTrace(trace: RootTrace): TracePayloadRow {
    return {
      id: trace.id,
      trace: storeTracePayload(trace),
    };
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

  const traceOptions = meta.trace ?? defaultTraceOptions;

  if (!traceOptions.enabled) {
    return undefined;
  }

  if (traceOptions.startOn === "devtoolOpen" && !store.isActive()) {
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
  _context: TraceContext,
  frame: TraceFrame,
): void => {
  frame.cached = true;
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
  return event;
};

export const endSelectEventSuccess = (
  _context: TraceContext,
  event: SelectCommandEvent,
  result: unknown[],
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.resultCount = result.length;
  event.result = result;
  event.status = "success";
};

export const endSelectEventError = (
  _context: TraceContext,
  event: SelectCommandEvent,
  error: unknown,
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "error";
  event.error = summarizeError(error);
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
  return event;
};

export const endMutationEventSuccess = (
  _context: TraceContext,
  event: MutationEvent,
  patch: Partial<
    Pick<MutationEvent, "rows" | "ids" | "oldValue" | "newValue">
  > = {},
): void => {
  Object.assign(event, patch);
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "success";
};

export const endMutationEventError = (
  _context: TraceContext,
  event: MutationEvent,
  error: unknown,
): void => {
  event.endedAt = wallClockNow();
  event.durationMs = finishDuration(event.startedAt);
  event.status = "error";
  event.error = summarizeError(error);
};
