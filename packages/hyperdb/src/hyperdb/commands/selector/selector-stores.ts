// Subscribable synchronous selector stores built on the selector cache.
import { SubscribableDB, type Op } from "../../runtime/subscribable-db";
import { deepFreeze } from "../../deep-freeze";
import { type ChildMemo } from "../runner";
import { type SelectRangeCmd } from "./commands";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./selector-memo";
import {
  type AnyObjectSelector,
  type SelectorReturn,
  type SelectorArgs,
  type SelectorStoreInput,
  type CachedSelectorStoreInput,
} from "./selector-definition";
import { runSelectorGeneratorSync } from "./selector-run";
import {
  type SelectorCacheEntry,
  type SelectorCacheStore,
  DEFAULT_SELECTOR_CACHE_GC_TIME,
  getSelectorCacheMap,
  runSelectorCacheGc,
  cancelSelectorCacheEntryGc,
  getSelectorMemoization,
  traceSelectorCacheHit,
  rerunSelectorCacheEntry,
  scheduleSelectorCacheEntryGc,
  ensureSelectorCacheEntrySubscribed,
} from "./selector-cache";

const createUncachedSelectorStoreSync = <TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  options: {
    freezeArgs?: boolean;
  },
): SelectorCacheStore<SelectorReturn<TSelector>> => {
  const freezeArgs =
    options.freezeArgs ?? db.getOptions?.().freezeArgs ?? false;
  const cachedArgs = freezeArgs ? deepFreeze(args) : args;
  const gen = () => selector(cachedArgs);
  const selectRangeCmds: SelectRangeCmd[] = [];
  const childMemo: ChildMemo = new Map();
  let currentResult = runSelectorGeneratorSync(db, gen, selectRangeCmds, {
    childMemo,
  });
  let currentRevision = db.getRevision();

  const rerun = (ops?: readonly Op[]) => {
    currentResult = runSelectorGeneratorSync(db, gen, selectRangeCmds, {
      ops,
      childMemo,
    });
    currentRevision = db.getRevision();
  };

  return {
    subscribe: (callback: () => void) => {
      const unsubscribe = db.subscribe((ops, _traits, revision) => {
        currentRevision = revision;
        if (!isNeedToRerunRange(selectRangeCmds, ops)) {
          return;
        }

        rerun(ops);
        callback();
      });

      if (currentRevision !== db.getRevision()) {
        rerun();
        callback();
      }

      return unsubscribe;
    },
    getSnapshot: () => currentResult,
    refresh: () => {
      rerun();
    },
    setSnapshot: (value) => {
      currentResult = value;
      currentRevision = db.getRevision();
    },
  };
};

export function createSelectorStoreSync<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  input: SelectorStoreInput<TSelector>,
): SelectorCacheStore<SelectorReturn<TSelector>> {
  return createUncachedSelectorStoreSync(db, input.selector, input.args, input);
}

export function createCachedSelectorStoreSync<
  TSelector extends AnyObjectSelector,
>(
  db: SubscribableDB,
  input: CachedSelectorStoreInput<TSelector>,
): SelectorCacheStore<SelectorReturn<TSelector>> {
  const { selector, args } = input;

  if (!getSelectorMemoization(selector).root) {
    return createUncachedSelectorStoreSync(db, selector, args, input);
  }

  const argsKey = stableSerializeSelectorArgs(args);
  const freezeArgs = input.freezeArgs ?? db.getOptions?.().freezeArgs ?? false;
  const cachedArgs = freezeArgs ? deepFreeze(args) : args;
  const byArgs = getSelectorCacheMap(db, selector);
  runSelectorCacheGc();
  let entry = byArgs.get(argsKey) as
    | SelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;

  if (!entry) {
    const selectRangeCmds: SelectRangeCmd[] = [];
    const childMemo: ChildMemo = new Map();
    const gen = () => selector(cachedArgs);
    const currentResult = runSelectorGeneratorSync(db, gen, selectRangeCmds, {
      childMemo,
    });
    entry = {
      argsKey,
      args: cachedArgs,
      db,
      selector,
      gen,
      currentResult,
      currentRevision: db.getRevision(),
      selectRangeCmds,
      childMemo,
      subscribers: new Set(),
    };
    byArgs.set(argsKey, entry as SelectorCacheEntry<unknown>);
  } else {
    cancelSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>);

    if (entry.needsRerun || entry.currentRevision !== db.getRevision()) {
      rerunSelectorCacheEntry(entry);
    } else {
      traceSelectorCacheHit(entry as SelectorCacheEntry<unknown>);
    }
  }

  return {
    subscribe: (callback: () => void) => {
      entry.subscribers.add(callback);
      cancelSelectorCacheEntryGc(entry as SelectorCacheEntry<unknown>);

      ensureSelectorCacheEntrySubscribed(entry);

      if (entry.needsRerun || entry.currentRevision !== db.getRevision()) {
        rerunSelectorCacheEntry(entry);
        callback();
      }

      return () => {
        entry.subscribers.delete(callback);

        if (entry.subscribers.size > 0) return;

        const gcTime = input.gcTime ?? DEFAULT_SELECTOR_CACHE_GC_TIME;
        scheduleSelectorCacheEntryGc(
          entry as SelectorCacheEntry<unknown>,
          gcTime,
        );
      };
    },
    getSnapshot: () => entry.currentResult,
    refresh: () => {
      rerunSelectorCacheEntry(entry);
    },
    setSnapshot: (value) => {
      entry.currentResult = value;
      entry.currentRevision = entry.db.getRevision();
      entry.needsRerun = false;
    },
  };
}
