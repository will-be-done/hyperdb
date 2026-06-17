import { createSelector } from "../hyperdb";
import { selectFrom } from "../hyperdb/commands/selector/builder";
import { v } from "../hyperdb/schema/values";
import {
  hyperDBTraceStore,
  traceRootsRuntimeTable,
  traceMetaId,
  traceMetaRuntimeTable,
  type RootTrace,
  type TraceQueryKind,
  type TraceRootRow,
  type TraceSortDir,
  type TraceSortField,
} from "../hyperdb/tracing/store";

const devtoolTraceOptions = { enabled: false, startOn: "devtoolOpen" } as const;
const selector = createSelector({ trace: devtoolTraceOptions });

export type TraceStoreTraceSelection = {
  visibleTraces: RootTrace[];
  selectedTrace: RootTrace | undefined;
};

const normalizedLimit = (maxTraces: number): number => {
  const n = Number(maxTraces);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
};

const traceSortIndex = (
  sortField: TraceSortField,
  dbKey: string | undefined,
):
  | "byStartedAt"
  | "byDurationMs"
  | "byDbStartedAt"
  | "byDbDurationMs" => {
  if (dbKey !== undefined) {
    return sortField === "duration" ? "byDbDurationMs" : "byDbStartedAt";
  }

  return sortField === "duration" ? "byDurationMs" : "byStartedAt";
};

function* selectTraceRows({
  maxTraces,
  sortField,
  sortDir,
  dbKey,
  kind,
  skipCached,
}: {
  maxTraces: number;
  sortField: TraceSortField;
  sortDir: TraceSortDir;
  dbKey?: string;
  kind?: TraceQueryKind;
  skipCached?: boolean;
}): Generator<unknown, TraceRootRow[], unknown> {
  const limit = normalizedLimit(maxTraces);
  let queryLimit = limit;

  while (true) {
    const rows = yield* selectTraceRowCandidates({
      limit: queryLimit,
      sortField,
      sortDir,
      dbKey,
    });
    const filteredRows = rows.filter((row) =>
      traceRowMatchesFilters(row, { kind, skipCached }),
    );

    if (filteredRows.length >= limit || rows.length < queryLimit) {
      return filteredRows.slice(0, limit);
    }

    queryLimit *= 2;
  }
}

function* selectTraceRowCandidates({
  limit,
  sortField,
  sortDir,
  dbKey,
}: {
  limit: number;
  sortField: TraceSortField;
  sortDir: TraceSortDir;
  dbKey?: string;
}): Generator<unknown, TraceRootRow[], unknown> {
  const index = traceSortIndex(sortField, dbKey);
  const query = selectFrom(traceRootsRuntimeTable, index)
    .order(sortDir)
    .limit(limit);

  if (dbKey !== undefined) {
    return yield* query.where((q) => q.eq("dbKey", dbKey));
  }

  return yield* query;
}

const traceRowMatchesFilters = (
  row: TraceRootRow,
  {
    kind,
    skipCached,
  }: {
    kind?: TraceQueryKind;
    skipCached?: boolean;
  },
): boolean =>
  (kind === undefined || row.kind === kind) &&
  (skipCached !== true || row.cached !== true);

const filterTraces = (
  traces: RootTrace[],
  {
    kind,
    skipCached,
  }: {
    kind?: TraceQueryKind;
    skipCached?: boolean;
  },
): RootTrace[] =>
  traces.filter(
    (trace) =>
      (kind === undefined || trace.kind === kind) &&
      (skipCached !== true || trace.frames[0]?.cached !== true),
  );

export const traceStoreTraces = selector({
  name: "traceStoreTraces",
  args: {
    maxTraces: v.number(),
    kind: v.union(v.literal("all"), v.literal("selector"), v.literal("action")),
    sortField: v.union(v.literal("created"), v.literal("duration")),
    sortDir: v.union(v.literal("asc"), v.literal("desc")),
  },
  handler: function* ({ maxTraces, kind, sortField, sortDir }) {
    yield* selectFrom(traceMetaRuntimeTable, "byId").where((q) =>
      q.eq("id", traceMetaId),
    );

    const rows = yield* selectTraceRows({
      maxTraces,
      sortField,
      sortDir,
      kind: kind === "all" ? undefined : kind,
    });

    return filterTraces(hyperDBTraceStore.resolveTraceRows(rows), {
      kind: kind === "all" ? undefined : kind,
    });
  },
});

export const traceStoreTraceSelection = selector({
  name: "traceStoreTraceSelection",
  args: {
    maxTraces: v.number(),
    kind: v.union(v.literal("all"), v.literal("selector"), v.literal("action")),
    dbKey: v.optional(v.string()),
    skipCached: v.boolean(),
    sortField: v.union(v.literal("created"), v.literal("duration")),
    sortDir: v.union(v.literal("asc"), v.literal("desc")),
    selectedTraceId: v.optional(v.string()),
  },
  handler: function* ({
    maxTraces,
    kind,
    dbKey,
    skipCached,
    sortField,
    sortDir,
    selectedTraceId,
  }): Generator<unknown, TraceStoreTraceSelection, unknown> {
    yield* selectFrom(traceMetaRuntimeTable, "byId").where((q) =>
      q.eq("id", traceMetaId),
    );

    const rows = yield* selectTraceRows({
      maxTraces,
      dbKey,
      sortField,
      sortDir,
      kind: kind === "all" ? undefined : kind,
      skipCached,
    });
    const visibleTraces = filterTraces(hyperDBTraceStore.resolveTraceRows(rows), {
      kind: kind === "all" ? undefined : kind,
      skipCached,
    });

    return {
      visibleTraces,
      selectedTrace:
        visibleTraces.find((trace) => trace.id === selectedTraceId) ??
        visibleTraces[0],
    };
  },
});
