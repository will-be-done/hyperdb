/* eslint-disable @typescript-eslint/no-explicit-any */
// Selector types and the createSelector() builder.
import type { SelectorGenerator } from "../command-types";
import { SubscribableDB } from "../../runtime/subscribable-db";
import type { Row } from "../../core/primitives";
import { type TraceOptions } from "../../core/tracer";
import {
  assertValid,
  v,
  type InferObject,
  type Validator,
} from "../../schema/values";
import { wrapGeneratorWithTraceMeta } from "../../tracing/metadata";
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
} from "../builder-common";

export type PartialScanOptions<T extends Row = Row> = {
  lte?: Partial<T>[];
  gte?: Partial<T>[];
  lt?: Partial<T>[];
  gt?: Partial<T>[];
  // limit?: number;
};

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
> = ((
  args: InferObject<TSchema>,
) => Generator<RunSelectorCmd, TReturn, unknown>) & {
  readonly kind: "selector";
  readonly name: string;
  readonly args: TSchema;
  readonly skipTrace?: SelectorTraceSkip;
  readonly memoization?: SelectorMemoization;
  readonly trace: TraceOptions;
  readonly validateArgs?: boolean;
  readonly handler: (args: InferObject<TSchema>) => SelectorGenerator<TReturn>;
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
  handler: (args: InferObject<TSchema>) => SelectorGenerator<TReturn>;
};

const defaultSelectorMemoization: SelectorMemoization = {
  root: true,
  selfChild: false,
};

export const normalizeSelectorMemoization = (
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
