// Root selector cache shared by cached reads and stores: entries, GC,
// invalidation subscriptions, and preloading.
import { SubscribableDB, type Op } from "../../runtime/subscribable-db";
import type { HyperDB } from "../../core/contracts";
import { deepFreeze } from "../../deep-freeze";
import { type TraceOptions } from "../../core/tracer";
import { type ChildMemo } from "../runner";
import { type SelectRangeCmd, type SelectorMemoization } from "./commands";
import {
  isTraceDisabled,
  normalizeTraceSkip,
  type NormalizedTraceSkip,
} from "../builder-common";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./selector-memo";
import {
  defaultTraceOptions,
  createTraceFrameMeta,
  recordCachedRootTrace,
} from "../../tracing/store";
import {
  type SelectorTraceSkip,
  type SelectorFactoryOptions,
  type AnyObjectSelector,
  type SelectorReturn,
  type SelectorArgs,
  type CachedSelectorRunInput,
  type PreloadSelectorInput,
  normalizeSelectorMemoization,
} from "./selector-definition";
import { runSelectorGenerator, runSelectorGeneratorSync } from "./selector-run";

export type SelectorCacheEntry<TReturn> = {
  argsKey: string;
  args: unknown;
  db: SubscribableDB;
  selector: object;
  gen: () => Generator<unknown, TReturn, unknown>;
  currentResult: TReturn;
  currentRevision: number;
  selectRangeCmds: SelectRangeCmd[];
  // Persists across reruns so nested-selector results/ranges survive between
  // revisions and can be reused when triggering ops miss their ranges.
  childMemo: ChildMemo;
  subscribers: Set<() => void>;
  needsRerun?: boolean;
  dbUnsubscribe?: () => void;
  gcExpiresAt?: number;
};

type PendingSelectorCacheEntry<TReturn> = {
  revision: number;
  promise: Promise<TReturn>;
  selectRangeCmds: SelectRangeCmd[];
};

export type SelectorCacheStore<TReturn> = {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => TReturn;
  refresh: () => void;
  setSnapshot: (value: TReturn) => void;
};

const selectorCache = new WeakMap<
  SubscribableDB,
  WeakMap<object, Map<string, SelectorCacheEntry<unknown>>>
>();
const pendingSelectorCache = new WeakMap<
  SubscribableDB,
  WeakMap<object, Map<string, PendingSelectorCacheEntry<unknown>>>
>();
export const DEFAULT_SELECTOR_CACHE_GC_TIME = 30_000;
const SELECTOR_CACHE_GC_TICK_MS = 1_000;
const selectorGcEntries = new Set<SelectorCacheEntry<unknown>>();
let selectorGcTicker: ReturnType<typeof setInterval> | undefined;

const subscribableCacheDBs = new WeakMap<HyperDB, SubscribableDB>();

export const getSubscribableHybridCacheDB = (
  db: SubscribableDB,
): SubscribableDB | undefined => {
  const cacheDB = db.getCacheDB?.();
  if (!cacheDB) return undefined;
  if (cacheDB instanceof SubscribableDB) return cacheDB;

  let subscribable = subscribableCacheDBs.get(cacheDB);
  if (!subscribable) {
    subscribable = new SubscribableDB(cacheDB);
    subscribableCacheDBs.set(cacheDB, subscribable);
  }

  return subscribable;
};

export const getSelectorCacheMap = (
  db: SubscribableDB,
  selector: object,
): Map<string, SelectorCacheEntry<unknown>> => {
  let bySelector = selectorCache.get(db);
  if (!bySelector) {
    bySelector = new WeakMap();
    selectorCache.set(db, bySelector);
  }

  let byArgs = bySelector.get(selector);
  if (!byArgs) {
    byArgs = new Map();
    bySelector.set(selector, byArgs);
  }

  return byArgs;
};

const getPendingSelectorCacheMap = (
  db: SubscribableDB,
  selector: object,
): Map<string, PendingSelectorCacheEntry<unknown>> => {
  let bySelector = pendingSelectorCache.get(db);
  if (!bySelector) {
    bySelector = new WeakMap();
    pendingSelectorCache.set(db, bySelector);
  }

  let byArgs = bySelector.get(selector);
  if (!byArgs) {
    byArgs = new Map();
    bySelector.set(selector, byArgs);
  }

  return byArgs;
};

const stopSelectorCacheGcTickerIfIdle = () => {
  if (selectorGcEntries.size > 0 || !selectorGcTicker) return;

  clearInterval(selectorGcTicker);
  selectorGcTicker = undefined;
};

export const runSelectorCacheGc = () => {
  const now = Date.now();

  for (const entry of selectorGcEntries) {
    if (entry.subscribers.size > 0) {
      selectorGcEntries.delete(entry);
      entry.gcExpiresAt = undefined;
      continue;
    }

    if (entry.gcExpiresAt !== undefined && entry.gcExpiresAt <= now) {
      deleteSelectorCacheEntry(entry);
    }
  }

  stopSelectorCacheGcTickerIfIdle();
};

const ensureSelectorCacheGcTicker = () => {
  if (selectorGcTicker) return;

  selectorGcTicker = setInterval(runSelectorCacheGc, SELECTOR_CACHE_GC_TICK_MS);
  (selectorGcTicker as { unref?: () => void }).unref?.();
};

export const cancelSelectorCacheEntryGc = (
  entry: SelectorCacheEntry<unknown>,
) => {
  if (!selectorGcEntries.delete(entry)) return;

  entry.gcExpiresAt = undefined;
  stopSelectorCacheGcTickerIfIdle();
};

const deleteSelectorCacheEntry = (entry: SelectorCacheEntry<unknown>) => {
  entry.dbUnsubscribe?.();
  entry.dbUnsubscribe = undefined;
  selectorGcEntries.delete(entry);
  entry.gcExpiresAt = undefined;

  const byArgs = selectorCache.get(entry.db)?.get(entry.selector);
  if (byArgs?.get(entry.argsKey) === entry) {
    byArgs.delete(entry.argsKey);
  }

  stopSelectorCacheGcTickerIfIdle();
};

const getSelectorTraceName = (selector: object): string => {
  const name = (selector as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0
    ? name
    : "anonymous selector";
};

const getSelectorTraceSkip = (selector: object): NormalizedTraceSkip => {
  const skipTrace = (selector as { skipTrace?: SelectorTraceSkip }).skipTrace;
  return normalizeTraceSkip(skipTrace);
};

export const getSelectorMemoization = (
  selector: object,
): SelectorMemoization => {
  const memoization = (selector as { memoization?: SelectorMemoization })
    .memoization;
  return normalizeSelectorMemoization(memoization);
};

const getSelectorFactoryOptions = (
  selector: object,
): Pick<Required<SelectorFactoryOptions>, "trace"> => ({
  trace: (selector as { trace?: TraceOptions }).trace ?? defaultTraceOptions,
});

export const traceSelectorCacheHit = (
  entry: SelectorCacheEntry<unknown>,
): void => {
  const skipTrace = getSelectorTraceSkip(entry.selector);
  const factoryOptions = getSelectorFactoryOptions(entry.selector);
  const traceDisabled = isTraceDisabled(factoryOptions.trace);
  recordCachedRootTrace(
    createTraceFrameMeta(
      "selector",
      getSelectorTraceName(entry.selector),
      entry.args,
      {
        trace: factoryOptions.trace,
        skipChildTrace: skipTrace.childTrace || traceDisabled,
        skipRootTrace: skipTrace.rootTrace || traceDisabled,
      },
    ),
    entry.db,
  );
};

export const rerunSelectorCacheEntry = <TReturn>(
  entry: SelectorCacheEntry<TReturn>,
  ops?: Op[],
) => {
  entry.currentResult = runSelectorGeneratorSync(
    entry.db,
    entry.gen,
    entry.selectRangeCmds,
    {
      ops,
      childMemo: entry.childMemo,
    },
  );
  entry.currentRevision = entry.db.getRevision();
  entry.needsRerun = false;
};

const copySelectRangeCmds = (
  target: SelectRangeCmd[],
  source: SelectRangeCmd[],
) => {
  target.splice(0, target.length, ...source);
};

const refreshSelectorCacheEntry = <TReturn>(
  mode: "sync" | "maybeAsync",
  entry: SelectorCacheEntry<TReturn>,
): TReturn | Promise<TReturn> => {
  const revision = entry.db.getRevision();
  const result = runSelectorGenerator(
    mode,
    entry.db,
    entry.gen,
    entry.selectRangeCmds,
    {
      childMemo: entry.childMemo,
    },
  );

  if (result instanceof Promise) {
    return result.then((value) => {
      if (entry.db.getRevision() !== revision) {
        entry.needsRerun = true;
        return value;
      }

      entry.currentResult = value;
      entry.currentRevision = revision;
      entry.needsRerun = false;
      return value;
    });
  }

  entry.currentResult = result;
  entry.currentRevision = entry.db.getRevision();
  entry.needsRerun = false;
  return result;
};

export const scheduleSelectorCacheEntryGc = (
  entry: SelectorCacheEntry<unknown>,
  gcTime: number,
) => {
  if (entry.subscribers.size > 0) return;

  if (gcTime <= 0) {
    deleteSelectorCacheEntry(entry);
    return;
  }

  entry.gcExpiresAt = Date.now() + gcTime;
  selectorGcEntries.add(entry);
  ensureSelectorCacheGcTicker();
};

const primeCachedSelector = <TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  value: SelectorReturn<TSelector>,
  selectRangeCmds: SelectRangeCmd[],
  options: {
    freezeArgs?: boolean;
    gcTime?: number;
  } = {},
) => {
  if (!getSelectorMemoization(selector).root) {
    return;
  }

  const argsKey = stableSerializeSelectorArgs(args);
  const freezeArgs =
    options.freezeArgs ?? db.getOptions?.().freezeArgs ?? false;
  const cachedArgs = freezeArgs ? deepFreeze(args) : args;
  const byArgs = getSelectorCacheMap(db, selector);
  runSelectorCacheGc();
  let entry = byArgs.get(argsKey) as
    | SelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;
  const gcTime = options.gcTime ?? DEFAULT_SELECTOR_CACHE_GC_TIME;

  if (!entry) {
    entry = {
      argsKey,
      args: cachedArgs,
      db,
      selector,
      gen: () => selector(cachedArgs),
      currentResult: value,
      currentRevision: db.getRevision(),
      selectRangeCmds: [...selectRangeCmds],
      childMemo: new Map(),
      subscribers: new Set(),
    };
    byArgs.set(argsKey, entry as SelectorCacheEntry<unknown>);
    ensureSelectorCacheEntrySubscribed(entry);
    scheduleSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>, gcTime);
    return;
  }

  cancelSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>);

  entry.currentResult = value;
  entry.currentRevision = db.getRevision();
  copySelectRangeCmds(entry.selectRangeCmds, selectRangeCmds);
  entry.childMemo = new Map();
  entry.needsRerun = false;
  ensureSelectorCacheEntrySubscribed(entry);
  scheduleSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>, gcTime);

  for (const subscriber of entry.subscribers) {
    subscriber();
  }
};

// "sync" never returns a promise: it ignores in-flight async runs and uses
// execSync, so it can only be served by synchronous storage.
const runCachedSelectorInternal = <TSelector extends AnyObjectSelector>(
  mode: "sync" | "maybeAsync",
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  selectRangeCmds: SelectRangeCmd[] = [],
  options: {
    freezeArgs?: boolean;
    gcTime?: number;
  } = {},
): SelectorReturn<TSelector> | Promise<SelectorReturn<TSelector>> => {
  if (!getSelectorMemoization(selector).root) {
    return runSelectorGenerator(
      mode,
      db,
      () => selector(args),
      selectRangeCmds,
    );
  }

  const argsKey = stableSerializeSelectorArgs(args);
  const freezeArgs =
    options.freezeArgs ?? db.getOptions?.().freezeArgs ?? false;
  const cachedArgs = freezeArgs ? deepFreeze(args) : args;
  const byArgs = getSelectorCacheMap(db, selector);
  const pendingByArgs =
    mode === "maybeAsync"
      ? getPendingSelectorCacheMap(db, selector)
      : undefined;
  runSelectorCacheGc();
  let entry = byArgs.get(argsKey) as
    | SelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;
  const gcTime = options.gcTime ?? DEFAULT_SELECTOR_CACHE_GC_TIME;

  if (entry) {
    cancelSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>);

    if (!entry.needsRerun && entry.currentRevision === db.getRevision()) {
      traceSelectorCacheHit(entry as SelectorCacheEntry<unknown>);
      copySelectRangeCmds(selectRangeCmds, entry.selectRangeCmds);
      scheduleSelectorCacheEntryGc(
        entry as SelectorCacheEntry<unknown>,
        gcTime,
      );
      return entry.currentResult;
    }

    const result = refreshSelectorCacheEntry(mode, entry);
    if (result instanceof Promise) {
      return result.then((value) => {
        if (!entry) return value;

        copySelectRangeCmds(selectRangeCmds, entry.selectRangeCmds);
        scheduleSelectorCacheEntryGc(
          entry as SelectorCacheEntry<unknown>,
          gcTime,
        );
        return value;
      });
    }

    copySelectRangeCmds(selectRangeCmds, entry.selectRangeCmds);
    scheduleSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>, gcTime);
    return result;
  }

  const pending = pendingByArgs?.get(argsKey) as
    | PendingSelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;
  if (pending) {
    if (pending.revision === db.getRevision()) {
      return pending.promise.then((value) => {
        copySelectRangeCmds(selectRangeCmds, pending.selectRangeCmds);
        return value;
      });
    }

    pendingByArgs?.delete(argsKey);
  }

  const entrySelectRangeCmds: SelectRangeCmd[] = [];
  const childMemo: ChildMemo = new Map();
  const gen = () => selector(cachedArgs);
  const revision = db.getRevision();
  const result = runSelectorGenerator(mode, db, gen, entrySelectRangeCmds, {
    childMemo,
  });
  let pendingEntry:
    | PendingSelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;
  const storeEntry = (value: SelectorReturn<TSelector>, needsRerun = false) => {
    if (pendingEntry && pendingByArgs?.get(argsKey) !== pendingEntry) {
      copySelectRangeCmds(selectRangeCmds, entrySelectRangeCmds);
      return value;
    }

    if (pendingEntry) {
      pendingByArgs?.delete(argsKey);
    }

    entry = {
      argsKey,
      args: cachedArgs,
      db,
      selector,
      gen,
      currentResult: value,
      currentRevision: needsRerun ? revision : db.getRevision(),
      selectRangeCmds: entrySelectRangeCmds,
      childMemo,
      subscribers: new Set(),
      needsRerun,
    };
    byArgs.set(argsKey, entry as SelectorCacheEntry<unknown>);
    copySelectRangeCmds(selectRangeCmds, entrySelectRangeCmds);
    ensureSelectorCacheEntrySubscribed(entry);
    scheduleSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>, gcTime);
    return value;
  };

  if (result instanceof Promise && pendingByArgs) {
    pendingEntry = {
      revision,
      promise: undefined as unknown as Promise<SelectorReturn<TSelector>>,
      selectRangeCmds: entrySelectRangeCmds,
    };
    const promise = result.then(
      (value) => storeEntry(value, db.getRevision() !== revision),
      (error: unknown) => {
        if (pendingByArgs.get(argsKey) === pendingEntry) {
          pendingByArgs.delete(argsKey);
        }

        throw error;
      },
    );
    pendingEntry.promise = promise;
    pendingByArgs.set(argsKey, pendingEntry);
    return promise;
  }

  if (result instanceof Promise)
    return result.then((value) => storeEntry(value));
  return storeEntry(result);
};

const runCachedSelectorSyncInternal = <TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: { freezeArgs?: boolean; gcTime?: number },
): SelectorReturn<TSelector> =>
  runCachedSelectorInternal(
    "sync",
    db,
    selector,
    args,
    selectRangeCmds,
    options,
  ) as SelectorReturn<TSelector>;

const runCachedSelectorMaybeAsyncInternal = <
  TSelector extends AnyObjectSelector,
>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: { freezeArgs?: boolean; gcTime?: number },
): SelectorReturn<TSelector> | Promise<SelectorReturn<TSelector>> =>
  runCachedSelectorInternal(
    "maybeAsync",
    db,
    selector,
    args,
    selectRangeCmds,
    options,
  );

export function runCachedSelectorSync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): SelectorReturn<TSelector> {
  return runCachedSelectorSyncInternal(
    db,
    input.selector,
    input.args,
    input.selectRangeCmds,
    input,
  );
}

export async function runCachedSelectorAsync<
  TSelector extends AnyObjectSelector,
>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> {
  return runCachedSelectorMaybeAsync(db, input);
}

export function runCachedSelectorMaybeAsync<
  TSelector extends AnyObjectSelector,
>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): SelectorReturn<TSelector> | Promise<SelectorReturn<TSelector>> {
  return runCachedSelectorMaybeAsyncInternal(
    db,
    input.selector,
    input.args,
    input.selectRangeCmds,
    input,
  );
}

export async function preloadSelectorAsync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: PreloadSelectorInput<TSelector>,
): Promise<SelectorReturn<TSelector>> {
  const selectRangeCmds: SelectRangeCmd[] = [];
  const value = await Promise.resolve(
    runCachedSelectorMaybeAsyncInternal(
      db,
      input.selector,
      input.args,
      selectRangeCmds,
      input,
    ),
  );
  const cacheDB =
    input.cacheDB === undefined
      ? getSubscribableHybridCacheDB(db)
      : input.cacheDB || undefined;

  if (cacheDB) {
    primeCachedSelector(
      cacheDB,
      input.selector,
      input.args,
      value,
      selectRangeCmds,
      input,
    );
  }

  return value;
}

export const ensureSelectorCacheEntrySubscribed = <TReturn>(
  entry: SelectorCacheEntry<TReturn>,
) => {
  if (entry.dbUnsubscribe) return;

  entry.dbUnsubscribe = entry.db.subscribe((ops, _traits, revision) => {
    if (!isNeedToRerunRange(entry.selectRangeCmds, ops)) {
      entry.currentRevision = revision;
      traceSelectorCacheHit(entry as SelectorCacheEntry<unknown>);
      return;
    }

    if (entry.subscribers.size === 0) {
      entry.currentRevision = revision;
      entry.needsRerun = true;
      return;
    }

    rerunSelectorCacheEntry(entry, ops);
    for (const subscriber of entry.subscribers) {
      subscriber();
    }
  });
};

export function selectCachedSync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): SelectorReturn<TSelector> {
  return runCachedSelectorSync(db, input);
}

export async function selectCachedAsync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> {
  return runCachedSelectorAsync(db, input);
}

export function selectCachedMaybeAsync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: CachedSelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> | SelectorReturn<TSelector> {
  return runCachedSelectorMaybeAsync(db, input);
}
