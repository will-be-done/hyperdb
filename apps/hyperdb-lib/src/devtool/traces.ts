import { createAction, createSelector } from "../hyperdb";
import { selectFrom } from "../hyperdb/commands/query/builder";
import { v } from "../hyperdb/schema/values";
import {
  hyperDBTraceStore,
  traceMetaId,
  traceMetaRuntimeTable,
} from "../hyperdb/tracing/store";

const action = createAction();
const selector = createSelector();

export const traceStoreTraces = selector({
  name: "traceStoreTraces",
  args: {
    maxTraces: v.number(),
    kind: v.union(v.literal("all"), v.literal("selector"), v.literal("action")),
  },
  handler: function* ({ maxTraces, kind }) {
    yield* selectFrom(traceMetaRuntimeTable, "byId").where((q) =>
      q.eq("id", traceMetaId),
    );

    return hyperDBTraceStore.getTraces(
      maxTraces,
      kind === "all" ? undefined : kind,
    );
  },
});

export const setTraceStoreMaxTraces = action({
  name: "setTraceStoreMaxTraces",
  args: { maxTraces: v.number() },
  handler: function* ({ maxTraces }) {
    hyperDBTraceStore.setMaxTraces(maxTraces);
  },
});

export const clearTraceStore = action({
  name: "clearTraceStore",
  args: {},
  handler: function* () {
    hyperDBTraceStore.clear();
  },
});

export const clearTraceStoreDB = action({
  name: "clearTraceStoreDB",
  args: { dbId: v.optional(v.string()) },
  handler: function* ({ dbId }) {
    hyperDBTraceStore.clearDB(dbId);
  },
});
