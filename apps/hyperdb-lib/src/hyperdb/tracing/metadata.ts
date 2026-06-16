import {
  createTraceFrameMeta,
  type TraceFrameMeta,
  type TraceKind,
} from "../core/tracer";

export const generatorTraceMetaKey = Symbol.for(
  "hyperdb.devtool.generatorMeta",
);

const commandFramePath = new WeakMap<object, TraceFrameMeta[]>();

export type TraceableGenerator<TReturn = unknown> = Generator<
  unknown,
  TReturn,
  unknown
> & {
  [generatorTraceMetaKey]?: TraceFrameMeta;
};

export const getGeneratorTraceMeta = (
  gen: Generator<unknown, unknown, unknown>,
): TraceFrameMeta | undefined =>
  (gen as TraceableGenerator)[generatorTraceMetaKey];

export const getCommandFramePath = (
  cmd: unknown,
): TraceFrameMeta[] | undefined => {
  if (typeof cmd !== "object" || cmd === null) return undefined;
  return commandFramePath.get(cmd);
};

const annotateCommand = (
  cmd: unknown,
  meta: TraceFrameMeta,
): unknown => {
  if (typeof cmd !== "object" || cmd === null) return cmd;
  if (meta.skipChildTrace) return cmd;

  const existingPath = commandFramePath.get(cmd);
  if (existingPath?.[0]?.id === meta.id) {
    return cmd;
  }

  commandFramePath.set(cmd, [meta, ...(existingPath ?? [])]);
  return cmd;
};

export const wrapGeneratorWithExistingTraceMeta = <TReturn>(
  gen: Generator<unknown, TReturn, unknown>,
  meta: TraceFrameMeta,
): Generator<unknown, TReturn, unknown> => {
  const annotateResult = (
    result: IteratorResult<unknown, TReturn>,
  ): IteratorResult<unknown, TReturn> =>
    result.done
      ? result
      : {
          done: false,
          value: annotateCommand(result.value, meta),
        };

  const traced = {
    next(value?: unknown): IteratorResult<unknown, TReturn> {
      return annotateResult(gen.next(value));
    },
    throw(error?: unknown): IteratorResult<unknown, TReturn> {
      if (!gen.throw) throw error;
      return annotateResult(gen.throw(error));
    },
    return(value?: TReturn): IteratorResult<unknown, TReturn> {
      if (!gen.return) {
        return { done: true, value: value as TReturn };
      }

      return annotateResult(gen.return(value as TReturn));
    },
    [Symbol.iterator]() {
      return this;
    },
  } as TraceableGenerator<TReturn>;

  Object.defineProperty(traced, generatorTraceMetaKey, {
    value: meta,
    enumerable: false,
    configurable: false,
  });

  return traced;
};

export const wrapGeneratorWithTraceMeta = <TReturn>(
  gen: Generator<unknown, TReturn, unknown>,
  kind: TraceKind,
  name: string,
  arg: unknown,
  options: Pick<
    TraceFrameMeta,
    "trace" | "autoTrace" | "skipRootTrace" | "skipChildTrace"
  > = {},
): Generator<unknown, TReturn, unknown> =>
  wrapGeneratorWithExistingTraceMeta(
    gen,
    createTraceFrameMeta(kind, name, arg, options),
  );

export const isGeneratorFunction = (fn: unknown): boolean => {
  if (typeof fn !== "function") return false;
  return fn.constructor?.name === "GeneratorFunction";
};
