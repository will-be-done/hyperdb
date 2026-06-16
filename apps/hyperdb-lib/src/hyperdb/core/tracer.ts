import type {
  SelectOptions,
  Trait,
  TupleScanOptions,
  Value,
  WhereClause,
} from "./primitives";

export type TraceKind = "action" | "selector" | "unknown";
export type TraceStatus = "running" | "success" | "error";
export type TraceQueryOrder = "asc" | "desc";
export type CommandEventKind = "select";
export type MutationEventKind = "insert" | "upsert" | "delete";

export type TraceError = {
  name?: string;
  message: string;
  stack?: string;
};

export type TraceFrameMeta = {
  id: string;
  kind: TraceKind;
  name: string;
  arg: unknown;
  trace?: boolean;
  autoTrace?: boolean;
  skipRootTrace?: boolean;
  skipChildTrace?: boolean;
};

export type TraceFrame = {
  id: string;
  parentId?: string;
  kind: TraceKind;
  name: string;
  arg: unknown;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceStatus;
  error?: TraceError;
  cached?: boolean;
  children: TraceFrame[];
  commandIds: string[];
  mutationIds: string[];
};

export type SelectCommandEvent = {
  id: string;
  frameId: string;
  kind: CommandEventKind;
  tableName: string;
  index: string;
  where: Required<WhereClause>[];
  bounds: SelectTraceInput["bounds"];
  limit?: SelectOptions["limit"];
  order?: TraceQueryOrder;
  resultCount?: number;
  result?: unknown[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceStatus;
  error?: TraceError;
};

export type MutationEvent = {
  id: string;
  frameId: string;
  kind: MutationEventKind;
  tableName: string;
  rows?: unknown[];
  ids?: string[];
  oldValue?: unknown[];
  newValue?: unknown[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceStatus;
  error?: TraceError;
};

export type RootTrace = {
  id: string;
  dbId?: string;
  dbLabel?: string;
  kind: TraceKind;
  name: string;
  arg: unknown;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceStatus;
  error?: TraceError;
  frames: TraceFrame[];
  commandEvents: SelectCommandEvent[];
  mutationEvents: MutationEvent[];
};

export type TraceStoreNotifier = {
  notify(): void;
};

export type TraceContext = {
  trace: RootTrace;
  rootFrame: TraceFrame;
  frameStack: TraceFrame[];
  frameMetas: TraceFrameMeta[];
  rootMetaId?: string;
  store: TraceStoreNotifier;
  tracer: HyperDBTracer;
};

export type SelectTraceInput = {
  tableName: string;
  index: string;
  where: Required<WhereClause>[];
  bounds: TupleScanOptions[];
  limit?: SelectOptions["limit"];
  order?: TraceQueryOrder;
};

export type MutationTraceInput = {
  kind: MutationEventKind;
  tableName: string;
  rows?: unknown[];
  ids?: string[];
  oldValue?: unknown[];
  newValue?: unknown[];
};

export type MutationTracePatch = Partial<
  Pick<MutationEvent, "rows" | "ids" | "oldValue" | "newValue">
>;

export interface HyperDBTracer {
  startRootTrace(
    meta: TraceFrameMeta,
    db?: object,
  ): TraceContext | undefined;
  enterFramePath(
    context: TraceContext,
    path: TraceFrameMeta[] | undefined,
  ): TraceFrame;
  getCurrentTraceFrame(context: TraceContext): TraceFrame;
  getCurrentTraceFrameMeta(context: TraceContext): TraceFrameMeta;
  markTraceFrameCached(context: TraceContext, frame: TraceFrame): void;
  endTraceSuccess(context: TraceContext): void;
  endTraceError(context: TraceContext, error: unknown): void;
  beginSelectEvent(
    context: TraceContext,
    frame: TraceFrame,
    input: SelectTraceInput,
  ): SelectCommandEvent;
  endSelectEventSuccess(
    context: TraceContext,
    event: SelectCommandEvent,
    result: unknown[],
  ): void;
  endSelectEventError(
    context: TraceContext,
    event: SelectCommandEvent,
    error: unknown,
  ): void;
  beginMutationEvent(
    context: TraceContext,
    frame: TraceFrame,
    input: MutationTraceInput,
  ): MutationEvent;
  endMutationEventSuccess(
    context: TraceContext,
    event: MutationEvent,
    patch?: MutationTracePatch,
  ): void;
  endMutationEventError(
    context: TraceContext,
    event: MutationEvent,
    error: unknown,
  ): void;
}

let metaIdCounter = 0;
let defaultHyperDBTracer: HyperDBTracer | undefined;

const nextMetaId = (): string => {
  metaIdCounter += 1;
  return `meta-${metaIdCounter}`;
};

export const createTraceFrameMeta = (
  kind: TraceKind,
  name: string,
  arg: unknown,
  options: Pick<
    TraceFrameMeta,
    "trace" | "autoTrace" | "skipRootTrace" | "skipChildTrace"
  > = {},
): TraceFrameMeta => ({
  id: nextMetaId(),
  kind,
  name,
  arg,
  ...options,
});

export const anonymousTraceMeta = (): TraceFrameMeta =>
  createTraceFrameMeta("unknown", "anonymous", undefined);

export const setDefaultHyperDBTracer = (
  tracer: HyperDBTracer | undefined,
): void => {
  defaultHyperDBTracer = tracer;
};

export const getDefaultHyperDBTracer = (): HyperDBTracer | undefined =>
  defaultHyperDBTracer;

export type HyperDBTracerConfigured = {
  getTracer?: () => HyperDBTracer | undefined | null;
};

export const getTracerForDB = (
  db: HyperDBTracerConfigured,
): HyperDBTracer | undefined => {
  const dbTracer = db.getTracer?.();
  if (dbTracer === null) return undefined;
  return dbTracer ?? defaultHyperDBTracer;
};

export const traceContextTraitType = "hyperdb.traceContext";

export type TraceContextTrait = Trait & {
  type: typeof traceContextTraitType;
  traceContext: TraceContext;
};

export const traceContextTrait = (
  traceContext: TraceContext,
): TraceContextTrait => ({
  type: traceContextTraitType,
  traceContext,
});

export const isTraceContextTrait = (
  trait: Trait,
): trait is TraceContextTrait =>
  trait.type === traceContextTraitType && "traceContext" in trait;

export const getTraceContextFromTraits = (
  traits: Trait[],
): TraceContext | undefined => {
  for (let index = traits.length - 1; index >= 0; index -= 1) {
    const trait = traits[index];
    if (trait && isTraceContextTrait(trait)) {
      return trait.traceContext;
    }
  }
};

export const getTraceContextForDB = (
  db: { getTraits(): Trait[] },
): TraceContext | undefined => getTraceContextFromTraits(db.getTraits());

export const withTraceContextTrait = <TDB extends {
  getTraits(): Trait[];
  withTraits(...trait: Trait[]): unknown;
}>(
  db: TDB,
  context: TraceContext,
): TDB => {
  if (getTraceContextForDB(db) === context) {
    return db;
  }

  return db.withTraits(traceContextTrait(context)) as TDB;
};

export type SerializableTraceValue = string | number | boolean | null | Value;
