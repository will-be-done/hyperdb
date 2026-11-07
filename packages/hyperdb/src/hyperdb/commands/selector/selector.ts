/* eslint-disable @typescript-eslint/no-explicit-any */
import { SubscribableDB, type Op } from "../../runtime/subscribable-db";
import { execAsync, execMaybeAsync, execSync } from "../../core/executor";
import type { DBCmd } from "../async";
import type { HyperDB } from "../../core/contracts";
import { deepFreeze } from "../../deep-freeze";
import type { Row } from "../../core/primitives";
import {
  driverTraceContextFromFrameMeta,
  getDriverTraceContextForDB,
  withDriverTraceContextTrait,
  type TraceOptions,
} from "../../core/tracer";
import {
  assertValid,
  v,
  type InferObject,
  type Validator,
} from "../../schema/values";
import {
  getGeneratorTraceMeta,
  wrapGeneratorWithTraceMeta,
} from "../../tracing/metadata";
import {
  pruneChildMemo,
  runCommandGenerator,
  type ChildMemo,
  type ChildVisited,
  type CommandRunnerOptions,
} from "../runner";
import {
  runSelectorType,
  type RunSelectorCmd,
  type SelectRangeCmd,
  type SelectorMemoization,
} from "./commands";
import { commandBrand } from "../brand";
import {
  assertCommandName,
  createFactoryOptions,
  defineCommandMetadata,
  isTraceDisabled,
  normalizeTraceSkip,
  type CommandTraceSkip,
  type FactoryConfigureOptions,
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

export type PartialScanOptions<T extends Row = Row> = {
  lte?: Partial<T>[];
  gte?: Partial<T>[];
  lt?: Partial<T>[];
  gt?: Partial<T>[];
  // limit?: number;
};

// type SelectEqualCmd = {
//   type: "selectEqual";
//   table: TableDefinition<any>;
//   indexName: string;
//   values: string[];
// };

// const isSelectCmd = (cmd: any): cmd is SelectEqualCmd =>
//   cmd.type === "selectEqual";

// export function* selectEqual<TTable extends TableDefinition<any>>(
//   table: TTable,
//   indexName: keyof TTable["indexes"],
//   vals: string[],
// ) {
//   return (yield {
//     type: "selectEqual",
//     table: table,
//     indexName: indexName as string,
//     values: vals,
//   } satisfies SelectEqualCmd) as ExtractSchema<TTable>[];
// }

export type SelectorArgsSchema = Record<string, Validator<any>>;
export type SelectorTraceSkip = CommandTraceSkip;
export type SelectorMemoizationOptions = Partial<SelectorMemoization>;
export type SelectorFactoryOptions = {
  trace?: TraceOptions;
  validateArgs?: boolean;
};
export type SelectorFactoryConfigureOptions = FactoryConfigureOptions;

export type ObjectSelector<
  TReturn,
  TSchema extends SelectorArgsSchema = SelectorArgsSchema,
> = ((args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "selector";
  readonly name: string;
  readonly args: TSchema;
  readonly skipTrace?: SelectorTraceSkip;
  readonly memoization?: SelectorMemoization;
  readonly trace: TraceOptions;
  readonly validateArgs?: boolean;
  readonly handler: (
    args: InferObject<TSchema>,
  ) => Generator<unknown, TReturn, unknown>;
};

export type AnyObjectSelector = ((
  args: any,
) => Generator<unknown, any, unknown>) & {
  readonly kind: "selector";
  readonly name: string;
  readonly args: SelectorArgsSchema;
  readonly skipTrace?: SelectorTraceSkip;
  readonly memoization?: SelectorMemoization;
  readonly trace: TraceOptions;
  readonly validateArgs?: boolean;
  readonly handler: (args: any) => Generator<unknown, any, unknown>;
};

export type SelectorReturn<TSelector> = TSelector extends (
  args: any,
) => Generator<unknown, infer TReturn, unknown>
  ? TReturn
  : never;

export type SelectorArgs<TSelector> = TSelector extends (
  args: infer TArgs,
) => Generator<unknown, any, unknown>
  ? TArgs
  : never;

export type SelectorInput<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
};

export type SelectorRunInput<TSelector extends AnyObjectSelector> =
  SelectorInput<TSelector> & {
    selectRangeCmds?: SelectRangeCmd[];
  };

export type CachedSelectorRunInput<TSelector extends AnyObjectSelector> =
  SelectorRunInput<TSelector> & {
    freezeArgs?: boolean;
    gcTime?: number;
  };

export type SelectorStoreInput<TSelector extends AnyObjectSelector> =
  SelectorInput<TSelector> & {
    freezeArgs?: boolean;
  };

export type CachedSelectorStoreInput<TSelector extends AnyObjectSelector> =
  SelectorStoreInput<TSelector> & {
    gcTime?: number;
  };

export type PreloadSelectorInput<TSelector extends AnyObjectSelector> =
  CachedSelectorRunInput<TSelector> & {
    cacheDB?: SubscribableDB | false;
  };

export type SelectorDefinition<TSchema extends SelectorArgsSchema, TReturn> = {
  name: string;
  args: TSchema;
  skipTrace?: SelectorTraceSkip;
  memoization?: SelectorMemoizationOptions;
  handler: (args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>;
};

const defaultSelectorMemoization: SelectorMemoization = {
  root: true,
  selfChild: false,
};

const normalizeSelectorMemoization = (
  memoization: SelectorMemoizationOptions | undefined,
): SelectorMemoization => ({
  root: memoization?.root ?? defaultSelectorMemoization.root,
  selfChild: memoization?.selfChild ?? defaultSelectorMemoization.selfChild,
});

export interface SelectorBuilder {
  <TSchema extends SelectorArgsSchema, TReturn>(
    definition: SelectorDefinition<TSchema, TReturn>,
  ): ObjectSelector<TReturn, TSchema>;
  configure(options: SelectorFactoryConfigureOptions): void;
}

export function createSelector(
  options: SelectorFactoryOptions = {},
): SelectorBuilder {
  const factory = createFactoryOptions(options);
  const factoryOptions = factory.current;

  const buildSelector = <TSchema extends SelectorArgsSchema, TReturn>(
    definition: SelectorDefinition<TSchema, TReturn>,
  ): ObjectSelector<TReturn, TSchema> => {
    const displayName = assertCommandName("Selector", definition.name);
    const skipTrace = normalizeTraceSkip(definition.skipTrace);
    const memoization = normalizeSelectorMemoization(definition.memoization);
    const argsValidator = v.object(definition.args);
    const wrapped = ((args: InferObject<typeof definition.args>) => {
      const traceDisabled = isTraceDisabled(factoryOptions.trace);
      const runnerSkipTrace = {
        childTrace: skipTrace.childTrace || traceDisabled,
        rootTrace: skipTrace.rootTrace || traceDisabled,
      };
      const normalizedArgs = factoryOptions.validateArgs
        ? assertValid(argsValidator, args)
        : args;
      const body = (function* () {
        return (yield {
          [commandBrand]: true,
          type: runSelectorType,
          selector: wrapped,
          args: normalizedArgs,
          makeBody: () => definition.handler(normalizedArgs),
          name: displayName,
          memoization,
          skipTrace: runnerSkipTrace,
        } satisfies RunSelectorCmd) as TReturn;
      })();

      return wrapGeneratorWithTraceMeta(
        body,
        "selector",
        displayName,
        normalizedArgs,
        {
          trace: factoryOptions.trace,
          skipChildTrace: skipTrace.childTrace || traceDisabled,
          skipRootTrace: skipTrace.rootTrace || traceDisabled,
        },
      );
    }) as ObjectSelector<TReturn, TSchema>;

    return defineCommandMetadata(
      wrapped,
      "selector",
      {
        name: displayName,
        args: definition.args,
        skipTrace: definition.skipTrace,
        trace: () => factoryOptions.trace,
        validateArgs: () => factoryOptions.validateArgs,
        handler: definition.handler,
      },
      { memoization },
    );
  };

  const builder = buildSelector as SelectorBuilder;
  builder.configure = factory.configure;

  return builder;
}

type RunSelectorOptions = Pick<CommandRunnerOptions, "ops" | "childMemo">;

const selectorGeneratorFactory =
  <TSelector extends AnyObjectSelector>(
    input: SelectorInput<TSelector>,
  ): (() => Generator<unknown, SelectorReturn<TSelector>, unknown>) =>
  () =>
    input.selector(input.args);

// When a childMemo is tracked, collect the selectors referenced this run so
// entries that were not referenced can be pruned afterwards (correctness for
// conditional branches, plus bounded memory).
const makeVisited = (options: RunSelectorOptions): ChildVisited | undefined =>
  options.childMemo ? new Map() : undefined;

function* runCommandGeneratorWithReadonlyTransaction<TReturn>(
  db: HyperDB,
  gen: Generator<unknown, TReturn, unknown>,
  options: CommandRunnerOptions,
): Generator<DBCmd, TReturn, unknown> {
  const runnerDB = withDriverTraceContextTrait(
    db,
    driverTraceContextFromFrameMeta(
      getGeneratorTraceMeta(gen),
      getDriverTraceContextForDB(db),
    ),
  );
  const tx = runnerDB.canUseReadonlyTransactionsForSelectors()
    ? yield* runnerDB.beginTx("readonly")
    : undefined;
  const scopedDB = tx ?? runnerDB;

  try {
    return yield* runCommandGenerator(scopedDB, gen, options);
  } finally {
    if (tx) {
      yield* tx.rollback();
    }
  }
}

type SelectorExecMode = "sync" | "async" | "maybeAsync";

const executors = {
  sync: execSync,
  async: execAsync,
  maybeAsync: execMaybeAsync,
} satisfies Record<
  SelectorExecMode,
  <T>(cmd: Generator<DBCmd, T>) => T | Promise<T>
>;

// One runner for every execution mode: "sync" never returns a promise,
// "async" always does, and "maybeAsync" returns one only if a step waited.
function runSelectorGenerator<TReturn>(
  mode: SelectorExecMode,
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[] = [],
  options: RunSelectorOptions = {},
): TReturn | Promise<TReturn> {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  const visited = makeVisited(options);
  const prune = (value: TReturn): TReturn => {
    if (options.childMemo && visited) {
      pruneChildMemo(options.childMemo, visited);
    }
    return value;
  };
  const result = executors[mode](
    runCommandGeneratorWithReadonlyTransaction(db, gen(), {
      ...options,
      selectRangeCmds,
      visited,
    }),
  );

  return result instanceof Promise ? result.then(prune) : prune(result);
}

const runSelectorGeneratorSync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): TReturn =>
  runSelectorGenerator("sync", db, gen, selectRangeCmds, options) as TReturn;

const runSelectorGeneratorAsync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): Promise<TReturn> =>
  runSelectorGenerator(
    "async",
    db,
    gen,
    selectRangeCmds,
    options,
  ) as Promise<TReturn>;

const runSelectorGeneratorMaybeAsync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): TReturn | Promise<TReturn> =>
  runSelectorGenerator("maybeAsync", db, gen, selectRangeCmds, options);

type SelectorCacheEntry<TReturn> = {
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

type SelectorCacheStore<TReturn> = {
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
const DEFAULT_SELECTOR_CACHE_GC_TIME = 30_000;
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

const getSelectorCacheMap = (
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

const runSelectorCacheGc = () => {
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

const cancelSelectorCacheEntryGc = (entry: SelectorCacheEntry<unknown>) => {
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

const getSelectorMemoization = (selector: object): SelectorMemoization => {
  const memoization = (selector as { memoization?: SelectorMemoization })
    .memoization;
  return normalizeSelectorMemoization(memoization);
};

const getSelectorFactoryOptions = (
  selector: object,
): Pick<Required<SelectorFactoryOptions>, "trace"> => ({
  trace: (selector as { trace?: TraceOptions }).trace ?? defaultTraceOptions,
});

const traceSelectorCacheHit = (entry: SelectorCacheEntry<unknown>): void => {
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

const rerunSelectorCacheEntry = <TReturn>(
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

const scheduleSelectorCacheEntryGc = (
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

  const rerun = (ops?: Op[]) => {
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

const ensureSelectorCacheEntrySubscribed = <TReturn>(
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

export function selectSync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): SelectorReturn<TSelector> {
  return runSelectorGeneratorSync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}

export async function selectAsync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> {
  return runSelectorGeneratorAsync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}

export function selectMaybeAsync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> | SelectorReturn<TSelector> {
  return runSelectorGeneratorMaybeAsync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}
