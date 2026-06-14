/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SubscribableDB, Op } from "../../runtime/subscribable-db";
import { execAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import type { Row } from "../../core/primitives";
import { isRowInRange } from "../../core/query/tuple";
import type { InferObject, Validator } from "../../schema/values";
import {
  isGeneratorFunction,
  wrapGeneratorWithTraceMeta,
} from "../../tracing/metadata";
import { runCommandGenerator } from "../runner";
import { type SelectRangeCmd } from "./commands";

export { isSelectRangeCmd, type SelectRangeCmd } from "./commands";

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

export type ObjectSelector<
  TArgs,
  TReturn,
  TSchema extends SelectorArgsSchema = SelectorArgsSchema,
> = ((args: TArgs) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "selector";
  readonly name: string;
  readonly args: TSchema;
  readonly handler: (args: TArgs) => Generator<unknown, TReturn, unknown>;
};

export type SelectorReturn<TSelector> =
  TSelector extends (args: any) => Generator<unknown, infer TReturn, unknown>
    ? TReturn
    : never;

export type SelectorArgs<TSelector> =
  TSelector extends (args: infer TArgs) => Generator<unknown, any, unknown>
    ? TArgs
    : never;

export type SelectorDefinition<
  TSchema extends SelectorArgsSchema,
  TReturn,
> = {
  name?: string;
  args: TSchema;
  handler: (
    args: InferObject<TSchema>,
  ) => Generator<unknown, TReturn, unknown>;
};

const defineSelectorMetadata = <
  TFn extends (...args: any[]) => Generator<unknown, unknown, unknown>,
>(
  fn: TFn,
  metadata: {
    name: string;
    args?: SelectorArgsSchema;
    handler: (...args: any[]) => Generator<unknown, unknown, unknown>;
  },
): TFn => {
  Object.defineProperties(fn, {
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
  });

  return fn;
};

export function selector<TSchema extends SelectorArgsSchema, TReturn>(
  definition: SelectorDefinition<TSchema, TReturn>,
): ObjectSelector<InferObject<TSchema>, TReturn, TSchema>;
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
    const displayName =
      input.name || input.handler.name || "anonymous selector";
    const wrapped = ((args: InferObject<typeof input.args>) =>
      wrapGeneratorWithTraceMeta(
        input.handler(args),
        "selector",
        displayName,
        [args],
      )) as ObjectSelector<
      InferObject<typeof input.args>,
      TReturn,
      typeof input.args
    >;

    return defineSelectorMetadata(wrapped, {
      name: displayName,
      args: input.args,
      handler: input.handler,
    }) as unknown as SelectorGeneratorFn<TReturn, TParams>;
  }

  const fn = input;
  const displayName = fn.name || "anonymous selector";
  const wrapped = ((...args: TParams) => {
    let generator: Generator<unknown, TReturn, unknown>;

    if (isGeneratorFunction(fn)) {
      const res = fn(...args);
      generator = res as Generator<unknown, TReturn, unknown>;
    } else {
      generator = (function* () {
        yield { type: noopType };

        return fn(...args);
      })() as Generator<unknown, TReturn, unknown>;
    }

    return wrapGeneratorWithTraceMeta(
      generator,
      "selector",
      displayName,
      args,
    );
  }) as SelectorGeneratorFn<TReturn, TParams>;

  return defineSelectorMetadata(wrapped, {
    name: displayName,
    handler: fn as SelectorGeneratorFn<unknown, any[]>,
  }) as SelectorGeneratorFn<TReturn, TParams>;
}

// TODO: maybe range tree instead?
export const isNeedToRerunRange = (cmds: SelectRangeCmd[], ops: Op[]): boolean => {
  for (const cmd of cmds) {
    for (const bound of cmd.bounds) {
      for (const op of ops) {
        if (op.table !== cmd.table) continue;

        if (op.type === "insert") {
          if (isRowInRange(op.newValue, cmd.table, cmd.index, bound)) {
            return true;
          }
        }

        if (op.type === "upsert") {
          if (
            op.oldValue &&
            isRowInRange(op.oldValue, cmd.table, cmd.index, bound)
          ) {
            // console.log(
            //   "need to rerun",
            //   op.oldValue,
            //   op.newValue,
            //   cmd.table,
            //   cmd.index,
            // );
            return true;
          }

          if (isRowInRange(op.newValue, cmd.table, cmd.index, bound)) {
            // console.log(
            //   "need to rerun",
            //   op.oldValue,
            //   op.newValue,
            //   cmd.table,
            //   cmd.index,
            // );
            return true;
          }
        }

        if (op.type === "delete") {
          if (isRowInRange(op.oldValue, cmd.table, cmd.index, bound)) {
            return true;
          }
        }
      }
    }
  }

  return false;
};

export function runSelector<TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[],
): TReturn {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  return execSync(runCommandGenerator(db, gen(), { selectRangeCmds }));
}

export async function runSelectorAsync<TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[] = [],
): Promise<TReturn> {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  return execAsync(runCommandGenerator(db, gen(), { selectRangeCmds }));
}

export function initSelector<TReturn>(
  db: SubscribableDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  debugKey?: string,
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
          if (debugKey) {
            console.log("selector no need to rerun", debugKey, ops);
          }
          return;
        }

        rerun();
        callback();

        if (!debugKey) return;
        console.log("selector callback", debugKey);
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
  db: SubscribableDB;
  selector: object;
  gen: () => Generator<unknown, TReturn, unknown>;
  currentResult: TReturn;
  currentRevision: number;
  selectRangeCmds: SelectRangeCmd[];
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

const isPlainSerializableObject = (
  value: object,
): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const serializeStableValue = (
  value: unknown,
  stack: WeakSet<object>,
  path: string,
): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot serialize selector args at ${path}: number must be finite`);
      }
      return `number:${String(value)}`;
    case "boolean":
      return `boolean:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "undefined":
      throw new Error(`Cannot serialize selector args at ${path}: undefined is not supported`);
    case "function":
      throw new Error(`Cannot serialize selector args at ${path}: functions are not supported`);
    case "symbol":
      throw new Error(`Cannot serialize selector args at ${path}: symbols are not supported`);
    case "object":
      break;
  }

  if (stack.has(value)) {
    throw new Error(`Cannot serialize selector args at ${path}: circular reference`);
  }

  stack.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) {
          throw new Error(
            `Cannot serialize selector args at ${path}[${index}]: sparse arrays are not supported`,
          );
        }

        items.push(serializeStableValue(value[index], stack, `${path}[${index}]`));
      }
      return `array:[${items.join(",")}]`;
    }

    if (!isPlainSerializableObject(value)) {
      throw new Error(
        `Cannot serialize selector args at ${path}: unsupported object type`,
      );
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new Error(
        `Cannot serialize selector args at ${path}: symbol keys are not supported`,
      );
    }

    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => {
      const serializedKey = JSON.stringify(key);
      const serializedValue = serializeStableValue(
        value[key],
        stack,
        `${path}.${key}`,
      );
      return `${serializedKey}:${serializedValue}`;
    });

    return `object:{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
};

export const stableSerializeSelectorArgs = (args: unknown): string =>
  serializeStableValue(args, new WeakSet(), "$");

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

const rerunSelectorCacheEntry = <TReturn>(
  entry: SelectorCacheEntry<TReturn>,
) => {
  entry.currentResult = runSelector(
    entry.db,
    entry.gen,
    entry.selectRangeCmds,
  );
  entry.currentRevision = entry.db.getRevision();
};

const ensureSelectorCacheEntrySubscribed = <TReturn>(
  entry: SelectorCacheEntry<TReturn>,
  debugKey?: string,
) => {
  if (entry.dbUnsubscribe) return;

  entry.dbUnsubscribe = entry.db.subscribe((ops, _traits, revision) => {
    entry.currentRevision = revision;
    if (!isNeedToRerunRange(entry.selectRangeCmds, ops)) {
      if (debugKey) {
        console.log("selector no need to rerun", debugKey, ops);
      }
      return;
    }

    rerunSelectorCacheEntry(entry);
    for (const subscriber of entry.subscribers) {
      subscriber();
    }

    if (!debugKey) return;
    console.log("selector callback", debugKey);
  });
};

export function initCachedSelector<TSelector extends ObjectSelector<any, any>>(
  db: SubscribableDB,
  selector: TSelector,
  args: SelectorArgs<TSelector>,
  options: {
    debugKey?: string;
    gcTime?: number;
  } = {},
): SelectorCacheStore<SelectorReturn<TSelector>> {
  const argsKey = stableSerializeSelectorArgs(args);
  const byArgs = getSelectorCacheMap(db, selector);
  let entry = byArgs.get(argsKey) as
    | SelectorCacheEntry<SelectorReturn<TSelector>>
    | undefined;

  if (!entry) {
    const selectRangeCmds: SelectRangeCmd[] = [];
    const gen = () => selector(args);
    const currentResult = runSelector(db, gen, selectRangeCmds);
    entry = {
      argsKey,
      db,
      selector,
      gen,
      currentResult,
      currentRevision: db.getRevision(),
      selectRangeCmds,
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
    }
  }

  return {
    subscribe: (callback: () => void) => {
      entry.subscribers.add(callback);
      if (entry.gcTimer) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = undefined;
      }

      ensureSelectorCacheEntrySubscribed(entry, options.debugKey);

      if (entry.currentRevision !== db.getRevision()) {
        rerunSelectorCacheEntry(entry);
        callback();
      }

      return () => {
        entry.subscribers.delete(callback);

        if (entry.subscribers.size > 0) return;

        entry.dbUnsubscribe?.();
        entry.dbUnsubscribe = undefined;

        const gcTime = options.gcTime ?? 0;
        if (gcTime > 0) {
          entry.gcTimer = setTimeout(() => {
            deleteSelectorCacheEntry(entry as SelectorCacheEntry<unknown>);
          }, gcTime);
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
