/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SubscribableDB, Op } from "../../runtime/subscribable-db";
import { execAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import { deepFreeze } from "../../deep-freeze";
import type { Row } from "../../core/primitives";
import type { InferObject, Validator } from "../../schema/values";
import {
  isGeneratorFunction,
  wrapGeneratorWithTraceMeta,
} from "../../tracing/metadata";
import {
  pruneChildMemo,
  runCommandGenerator,
  type ChildMemo,
  type ChildVisited,
  type CommandRunnerOptions,
} from "../runner";
import { type RunSelectorCmd, type SelectRangeCmd } from "./commands";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./selector-memo";
import {
  createTraceFrameMeta,
  recordCachedRootTrace,
} from "../../tracing/store";

export { isSelectRangeCmd, type SelectRangeCmd } from "./commands";
export {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./selector-memo";

export type PartialScanOptions<T extends Row = Row> = {
  lte?: Partial<T>[];
  gte?: Partial<T>[];
  lt?: Partial<T>[];
  gt?: Partial<T>[];
  // limit?: number;
};

const noopType = "noop";
type NoopCmd = { type: typeof noopType };

// type SelectEqualCmd = {
//   type: "selectEqual";
//   table: TableDefinition<any>;
//   indexName: string;
//   values: string[];
// };

export const isNoopCmd = (cmd: any): cmd is NoopCmd => cmd.type === noopType;
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

export type SelectorGeneratorFn<TReturn, TParams extends any[]> = (
  ...args: TParams
) => Generator<unknown, TReturn, unknown>;
export type SelectorFn<TReturn, TParams extends any[]> = (
  ...args: TParams
) => TReturn;

export type SelectorArgsSchema = Record<string, Validator<any>>;
export type SelectorTraceSkip =
  | boolean
  | {
      childTrace: boolean;
      rootTrace: boolean;
    };

export type ObjectSelector<
  TReturn,
  TSchema extends SelectorArgsSchema = SelectorArgsSchema,
> = ((args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "selector";
  readonly name: string;
  readonly args: TSchema;
  readonly skipTrace?: SelectorTraceSkip;
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

export type SelectorDefinition<TSchema extends SelectorArgsSchema, TReturn> = {
  name: string;
  args: TSchema;
  skipTrace?: SelectorTraceSkip;
  handler: (args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>;
};

type NormalizedSelectorTraceSkip = {
  childTrace: boolean;
  rootTrace: boolean;
};

const normalizeSelectorTraceSkip = (
  skipTrace: SelectorTraceSkip | undefined,
): NormalizedSelectorTraceSkip => {
  if (skipTrace === true) {
    return { childTrace: true, rootTrace: true };
  }

  if (!skipTrace) {
    return { childTrace: false, rootTrace: false };
  }

  return {
    childTrace: skipTrace.childTrace,
    rootTrace: skipTrace.rootTrace,
  };
};

const defineSelectorMetadata = <
  TFn extends (...args: any[]) => Generator<unknown, unknown, unknown>,
>(
  fn: TFn,
  metadata: {
    name: string;
    args?: SelectorArgsSchema;
    skipTrace?: SelectorTraceSkip;
    handler: (...args: any[]) => Generator<unknown, unknown, unknown>;
  },
): TFn => {
  const descriptors: PropertyDescriptorMap = {
    kind: {
      value: "selector",
      enumerable: true,
      configurable: false,
    },
    name: {
      value: metadata.name,
      enumerable: false,
      configurable: true,
    },
    args: {
      value: metadata.args,
      enumerable: true,
      configurable: false,
    },
    handler: {
      value: metadata.handler,
      enumerable: true,
      configurable: false,
    },
  };

  if (metadata.skipTrace !== undefined) {
    descriptors.skipTrace = {
      value: metadata.skipTrace,
      enumerable: true,
      configurable: false,
    };
  }

  Object.defineProperties(fn, descriptors);

  return fn;
};

const positionalTraceArg = (args: unknown[]): unknown => {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
};

const assertSelectorName = (name: unknown): string => {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Selector name is required");
  }

  return name;
};

export function selector<TSchema extends SelectorArgsSchema, TReturn>(
  definition: SelectorDefinition<TSchema, TReturn>,
): ObjectSelector<TReturn, TSchema>;
export function selector<TReturn, TParams extends any[]>(
  fn: SelectorGeneratorFn<TReturn, TParams>,
): SelectorGeneratorFn<TReturn, TParams>;
export function selector<TReturn, TParams extends any[]>(
  fn: SelectorFn<TReturn, TParams>,
): SelectorGeneratorFn<TReturn, TParams>;
export function selector<TReturn, TParams extends any[]>(
  input:
    | SelectorDefinition<SelectorArgsSchema, TReturn>
    | SelectorGeneratorFn<TReturn, TParams>
    | SelectorFn<TReturn, TParams>,
): SelectorGeneratorFn<TReturn, TParams> {
  if (typeof input !== "function") {
    const definition = input;
    const displayName = assertSelectorName(definition.name);
    const skipTrace = normalizeSelectorTraceSkip(definition.skipTrace);
    const wrapped = ((args: InferObject<typeof definition.args>) => {
      const body = (function* () {
        return (yield {
          type: "runSelector",
          selector: wrapped,
          args,
          makeBody: () => definition.handler(args),
          name: displayName,
          skipTrace,
        } satisfies RunSelectorCmd) as TReturn;
      })();

      return wrapGeneratorWithTraceMeta(body, "selector", displayName, args, {
        skipChildTrace: skipTrace.childTrace,
        skipRootTrace: skipTrace.rootTrace,
      });
    }) as ObjectSelector<TReturn, typeof definition.args>;

    return defineSelectorMetadata(wrapped, {
      name: displayName,
      args: definition.args,
      skipTrace: definition.skipTrace,
      handler: definition.handler,
    }) as unknown as SelectorGeneratorFn<TReturn, TParams>;
  }

  const fn = input;
  const displayName = fn.name || "anonymous selector";
  const makeBody = (args: TParams): Generator<unknown, unknown, unknown> => {
    if (isGeneratorFunction(fn)) {
      return fn(...args) as Generator<unknown, unknown, unknown>;
    }

    return (function* () {
      yield { type: noopType };

      return fn(...args);
    })();
  };

  const wrapped = ((...args: TParams) => {
    const body = (function* () {
      return (yield {
        type: "runSelector",
        selector: wrapped,
        args: positionalTraceArg(args),
        makeBody: () => makeBody(args),
        name: displayName,
      } satisfies RunSelectorCmd) as TReturn;
    })();

    return wrapGeneratorWithTraceMeta(
      body,
      "selector",
      displayName,
      positionalTraceArg(args),
    );
  }) as SelectorGeneratorFn<TReturn, TParams>;

  return defineSelectorMetadata(wrapped, {
    name: displayName,
    handler: fn as SelectorGeneratorFn<unknown, any[]>,
  }) as SelectorGeneratorFn<TReturn, TParams>;
}

type RunSelectorOptions = Pick<CommandRunnerOptions, "ops" | "childMemo">;

// When a childMemo is tracked, collect the selectors referenced this run so
// entries that were not referenced can be pruned afterwards (correctness for
// conditional branches, plus bounded memory).
const makeVisited = (options: RunSelectorOptions): ChildVisited | undefined =>
  options.childMemo ? new Map() : undefined;

export function runSelector<TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[],
  options: RunSelectorOptions = {},
): TReturn {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  const visited = makeVisited(options);
  const result = execSync(
    runCommandGenerator(db, gen(), { ...options, selectRangeCmds, visited }),
  );
  if (options.childMemo && visited) {
    pruneChildMemo(options.childMemo, visited);
  }
  return result;
}

export async function runSelectorAsync<TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[] = [],
  options: RunSelectorOptions = {},
): Promise<TReturn> {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  const visited = makeVisited(options);
  const result = await execAsync(
    runCommandGenerator(db, gen(), { ...options, selectRangeCmds, visited }),
  );
  if (options.childMemo && visited) {
    pruneChildMemo(options.childMemo, visited);
  }
  return result;
}

export function initSelector<TReturn>(
  db: SubscribableDB,
  gen: () => Generator<unknown, TReturn, unknown>,
): {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => TReturn;
} {
  let currentResult: TReturn | undefined;
  let currentRevision: number;
  const selectRangeCmds: SelectRangeCmd[] = [];

  currentResult = runSelector(db, gen, selectRangeCmds);
  currentRevision = db.getRevision();

  const rerun = () => {
    currentResult = runSelector(db, gen, selectRangeCmds);
    currentRevision = db.getRevision();
  };

  return {
    subscribe: (callback: () => void) => {
      const dbUnsubscribes: (() => void)[] = [];

      const unsubscribe = db.subscribe((ops, _traits, revision) => {
        currentRevision = revision;
        if (!isNeedToRerunRange(selectRangeCmds, ops)) {
          return;
        }

        rerun();
        callback();
      });

      dbUnsubscribes.push(unsubscribe);

      if (currentRevision !== db.getRevision()) {
        rerun();
        callback();
      }

      return () => {
        for (const unsubscribe of dbUnsubscribes) {
          unsubscribe();
        }
      };
    },
    getSnapshot: () => currentResult!,
  };
}

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
  dbUnsubscribe?: () => void;
  gcTimer?: ReturnType<typeof setTimeout>;
};

type SelectorCacheStore<TReturn> = {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => TReturn;
};

const selectorCache = new WeakMap<
  SubscribableDB,
  WeakMap<object, Map<string, SelectorCacheEntry<unknown>>>
>();
const DEFAULT_SELECTOR_CACHE_GC_TIME = 3_000;

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

const deleteSelectorCacheEntry = (entry: SelectorCacheEntry<unknown>) => {
  entry.dbUnsubscribe?.();
  entry.dbUnsubscribe = undefined;
  if (entry.gcTimer) {
    clearTimeout(entry.gcTimer);
    entry.gcTimer = undefined;
  }

  const byArgs = selectorCache.get(entry.db)?.get(entry.selector);
  if (byArgs?.get(entry.argsKey) === entry) {
    byArgs.delete(entry.argsKey);
  }
};

const getSelectorTraceName = (selector: object): string => {
  const name = (selector as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0
    ? name
    : "anonymous selector";
};

const getSelectorTraceSkip = (
  selector: object,
): NormalizedSelectorTraceSkip => {
  const skipTrace = (selector as { skipTrace?: SelectorTraceSkip }).skipTrace;
  return normalizeSelectorTraceSkip(skipTrace);
};

const traceSelectorCacheHit = (entry: SelectorCacheEntry<unknown>): void => {
  const skipTrace = getSelectorTraceSkip(entry.selector);
  recordCachedRootTrace(
    createTraceFrameMeta(
      "selector",
      getSelectorTraceName(entry.selector),
      entry.args,
      {
        skipChildTrace: skipTrace.childTrace,
        skipRootTrace: skipTrace.rootTrace,
      },
    ),
    entry.db,
  );
};

const rerunSelectorCacheEntry = <TReturn>(
  entry: SelectorCacheEntry<TReturn>,
  ops?: Op[],
) => {
  entry.currentResult = runSelector(
    entry.db,
    entry.gen,
    entry.selectRangeCmds,
    {
      ops,
      childMemo: entry.childMemo,
    },
  );
  entry.currentRevision = entry.db.getRevision();
};

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

    rerunSelectorCacheEntry(entry, ops);
    for (const subscriber of entry.subscribers) {
      subscriber();
    }
  });
};

export function initCachedSelector<TSelector extends AnyObjectSelector>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  options: {
    freezeArgs?: boolean;
    gcTime?: number;
  } = {},
): SelectorCacheStore<SelectorReturn<TSelector>> {
  const argsKey = stableSerializeSelectorArgs(args);
  const freezeArgs =
    options.freezeArgs ?? db.getOptions?.().freezeArgs ?? false;
  const cachedArgs = freezeArgs ? deepFreeze(args) : args;
  const byArgs = getSelectorCacheMap(db, selector);
  let entry = byArgs.get(argsKey) as
    | SelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;

  if (!entry) {
    const selectRangeCmds: SelectRangeCmd[] = [];
    const childMemo: ChildMemo = new Map();
    const gen = () => selector(cachedArgs);
    const currentResult = runSelector(db, gen, selectRangeCmds, { childMemo });
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
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }

    if (entry.currentRevision !== db.getRevision()) {
      rerunSelectorCacheEntry(entry);
    } else {
      traceSelectorCacheHit(entry as SelectorCacheEntry<unknown>);
    }
  }

  return {
    subscribe: (callback: () => void) => {
      entry.subscribers.add(callback);
      if (entry.gcTimer) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = undefined;
      }

      ensureSelectorCacheEntrySubscribed(entry);

      if (entry.currentRevision !== db.getRevision()) {
        rerunSelectorCacheEntry(entry);
        callback();
      }

      return () => {
        entry.subscribers.delete(callback);

        if (entry.subscribers.size > 0) return;

        entry.dbUnsubscribe?.();
        entry.dbUnsubscribe = undefined;

        const gcTime = options.gcTime ?? DEFAULT_SELECTOR_CACHE_GC_TIME;
        if (gcTime > 0) {
          entry.gcTimer = setTimeout(() => {
            deleteSelectorCacheEntry(entry as SelectorCacheEntry<unknown>);
          }, gcTime);
          (entry.gcTimer as { unref?: () => void }).unref?.();
          return;
        }

        deleteSelectorCacheEntry(entry as SelectorCacheEntry<unknown>);
      };
    },
    getSnapshot: () => entry.currentResult,
  };
}

export function select<TReturn>(
  db: HyperDB,
  gen: Generator<unknown, TReturn, unknown>,
): TReturn {
  return runSelector(db, () => gen, []);
}
