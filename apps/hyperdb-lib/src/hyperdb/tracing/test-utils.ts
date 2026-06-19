import { hyperDBTraceStore, type HyperDBTraceStore } from "./store";

export const flushTraceCommits = async (
  store: HyperDBTraceStore = hyperDBTraceStore,
): Promise<void> => {
  store.flushTraceCommits();
};
