import { createSelector } from "../hyperdb";
import { selectFrom } from "../hyperdb/commands/selector/builder";
import { v } from "../hyperdb/schema/values";
import {
  hydrateTracePayload,
  tracePayloadsRuntimeTable,
  traceRootsRuntimeTable,
  type RootTrace,
  type TraceQueryKind,
  type TraceRootRow,
  type TraceSortDir,
  type TraceSortField,
} from "../hyperdb/tracing/store";

const devtoolTraceOptions = { enabled: false, startOn: "devtoolOpen" } as const;
const selector = createSelector({ trace: devtoolTraceOptions });

export type TraceSummary = {
  id: string;
  dbId?: string;
  dbLabel?: string;
  kind: RootTrace["kind"];
  name: string;
  startedAt: number;
  durationMs?: number;
  status: RootTrace["status"];
  cached: boolean;
  selectCount: number;
  queriedRowCount: number;
  hasPendingSelect: boolean;
  actionCount: number;
  mutatedRowCount: number;
};

export type TraceStoreTraceSelection = {
  visibleTraces: TraceSummary[];
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

function* selectTracePayload(
  id: string,
): Generator<unknown, RootTrace | undefined, unknown> {
  const payloadRows = yield* selectFrom(
    tracePayloadsRuntimeTable,
    "byId",
  ).where((q) => q.eq("id", id));
  const payload = payloadRows[0];

  return payload ? hydrateTracePayload(payload.trace) : undefined;
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

const traceSummaryFromRow = (row: TraceRootRow): TraceSummary => ({
  id: row.id,
  dbId: row.dbId,
  dbLabel: row.dbLabel,
  kind: row.kind,
  name: row.name,
  startedAt: row.startedAt,
  durationMs: row.status === "running" ? undefined : row.durationMs,
  status: row.status,
  cached: row.cached,
  selectCount: row.selectCount,
  queriedRowCount: row.queriedRowCount,
  hasPendingSelect: row.hasPendingSelect,
  actionCount: row.actionCount,
  mutatedRowCount: row.mutatedRowCount,
});

export const traceStoreTraces = selector({
  name: "traceStoreTraces",
  args: {
    maxTraces: v.number(),
    kind: v.union(v.literal("all"), v.literal("selector"), v.literal("action")),
    sortField: v.union(v.literal("created"), v.literal("duration")),
    sortDir: v.union(v.literal("asc"), v.literal("desc")),
  },
  handler: function* ({ maxTraces, kind, sortField, sortDir }) {
    const rows = yield* selectTraceRows({
      maxTraces,
      sortField,
      sortDir,
      kind: kind === "all" ? undefined : kind,
    });

    return rows.map(traceSummaryFromRow);
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
    autoSelectFirst: v.optional(v.boolean()),
  },
  handler: function* ({
    maxTraces,
    kind,
    dbKey,
    skipCached,
    sortField,
    sortDir,
    selectedTraceId,
    autoSelectFirst = true,
  }): Generator<unknown, TraceStoreTraceSelection, unknown> {
    const rows = yield* selectTraceRows({
      maxTraces,
      dbKey,
      sortField,
      sortDir,
      kind: kind === "all" ? undefined : kind,
      skipCached,
    });
    const selectedRow =
      rows.find((row) => row.id === selectedTraceId) ??
      (autoSelectFirst ? rows[0] : undefined);

    return {
      visibleTraces: rows.map(traceSummaryFromRow),
      selectedTrace: selectedRow
        ? yield* selectTracePayload(selectedRow.id)
        : undefined,
    };
  },
});
