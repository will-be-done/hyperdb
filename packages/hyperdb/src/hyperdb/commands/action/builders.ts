/* eslint-disable @typescript-eslint/no-explicit-any */
import { runCommandGenerator } from "../runner";
import { execMaybeAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import type { DBCmd } from "../async";
import type { Trait } from "../../core/primitives";
import {
  defaultTraceOptions,
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
import type { ExtractSchema, TableDefinition } from "../../schema/table";
import {
  getGeneratorTraceMeta,
  wrapGeneratorWithTraceMeta,
} from "../../tracing/metadata";
import {
  deleteType,
  getCurrentTraitsType,
  insertType,
  upsertType,
  type DeleteActionCmd,
  type GetCurrentTraitsCmd,
  type InsertActionCmd,
  type UpsertActionCmd,
} from "./commands";
import { commandBrand } from "../brand";

export type ActionArgsSchema = Record<string, Validator<any>>;
export type ActionTraceSkip =
  | boolean
  | {
      childTrace: boolean;
      rootTrace: boolean;
    };
export type ActionFactoryOptions = {
  trace?: TraceOptions;
  validateArgs?: boolean;
};
export type ActionFactoryConfigureOptions = {
  trace?: Partial<TraceOptions>;
  validateArgs?: boolean;
};

export type ObjectAction<
  TReturn,
  TSchema extends ActionArgsSchema = ActionArgsSchema,
> = ((args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "action";
  readonly name: string;
  readonly args: TSchema;
  readonly skipTrace?: ActionTraceSkip;
  readonly trace: TraceOptions;
  readonly validateArgs?: boolean;
  readonly handler: (
    args: InferObject<TSchema>,
  ) => Generator<unknown, TReturn, unknown>;
};

export type ActionDefinition<TSchema extends ActionArgsSchema, TReturn> = {
  name: string;
  args: TSchema;
  skipTrace?: ActionTraceSkip;
  handler: (args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>;
};

type NormalizedActionTraceSkip = {
  childTrace: boolean;
  rootTrace: boolean;
};

const normalizeActionTraceSkip = (
  skipTrace: ActionTraceSkip | undefined,
): NormalizedActionTraceSkip => {
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

const defineActionMetadata = <
  TFn extends (...args: any[]) => Generator<unknown, unknown, unknown>,
>(
  fn: TFn,
  metadata: {
    name: string;
    args?: ActionArgsSchema;
    skipTrace?: ActionTraceSkip;
    trace: TraceOptions | (() => TraceOptions);
    validateArgs?: boolean | (() => boolean);
    handler: (...args: any[]) => Generator<unknown, unknown, unknown>;
  },
): TFn => {
  const descriptors: PropertyDescriptorMap = {
    kind: {
      value: "action",
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
    trace: {
      get:
        typeof metadata.trace === "function"
          ? metadata.trace
          : () => metadata.trace,
      enumerable: true,
      configurable: false,
    },
    validateArgs: {
      get:
        typeof metadata.validateArgs === "function"
          ? metadata.validateArgs
          : () => metadata.validateArgs,
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

const assertActionName = (name: unknown): string => {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Action name is required");
  }

  return name;
};

export interface ActionBuilder {
  <TSchema extends ActionArgsSchema, TReturn>(
    definition: ActionDefinition<TSchema, TReturn>,
  ): ObjectAction<TReturn, TSchema>;
  configure(options: ActionFactoryConfigureOptions): void;
}

const defaultActionFactoryOptions: Required<ActionFactoryOptions> = {
  trace: defaultTraceOptions,
  validateArgs: false,
};

const isTraceDisabled = (trace: TraceOptions): boolean => !trace.enabled;

export function createAction(
  options: ActionFactoryOptions = {},
): ActionBuilder {
  const factoryOptions = {
    ...defaultActionFactoryOptions,
    ...options,
    trace: {
      ...defaultActionFactoryOptions.trace,
      ...options.trace,
    },
  };

  const configure = (nextOptions: ActionFactoryConfigureOptions): void => {
    if (nextOptions.trace !== undefined) {
      factoryOptions.trace = {
        ...factoryOptions.trace,
        ...nextOptions.trace,
      };
    }
    if (nextOptions.validateArgs !== undefined) {
      factoryOptions.validateArgs = nextOptions.validateArgs;
    }
  };

  const buildAction = <TSchema extends ActionArgsSchema, TReturn>(
    input: ActionDefinition<TSchema, TReturn>,
  ): ObjectAction<TReturn, TSchema> => {
    const displayName = assertActionName(input.name);
    const argsValidator = v.object(input.args);
    const skipTrace = normalizeActionTraceSkip(input.skipTrace);
    const wrapped = ((args: InferObject<typeof input.args>) => {
      const traceDisabled = isTraceDisabled(factoryOptions.trace);
      const normalizedArgs = factoryOptions.validateArgs
        ? assertValid(argsValidator, args)
        : args;

      return wrapGeneratorWithTraceMeta(
        input.handler(normalizedArgs),
        "action",
        displayName,
        normalizedArgs,
        {
          trace: factoryOptions.trace,
          skipChildTrace: skipTrace.childTrace || traceDisabled,
          skipRootTrace: skipTrace.rootTrace || traceDisabled,
        },
      );
    }) as ObjectAction<TReturn, TSchema>;

    return defineActionMetadata(wrapped, {
      name: displayName,
      args: input.args,
      skipTrace: input.skipTrace,
      trace: () => factoryOptions.trace,
      validateArgs: () => factoryOptions.validateArgs,
      handler: input.handler,
    });
  };

  const builder = buildAction as ActionBuilder;
  builder.configure = configure;

  return builder;
}

export function* insert<TTable extends TableDefinition<any, any>>(
  table: TTable,
  values: ExtractSchema<TTable>[],
): Generator<unknown> {
  yield {
    [commandBrand]: true,
    type: insertType,
    table,
    values,
  } satisfies InsertActionCmd;
}

export function* upsert<TTable extends TableDefinition<any, any>>(
  table: TTable,
  values: ExtractSchema<TTable>[],
): Generator<unknown> {
  yield {
    [commandBrand]: true,
    type: upsertType,
    table,
    values,
  } satisfies UpsertActionCmd;
}

export function* deleteRows<TTable extends TableDefinition<any, any>>(
  table: TTable,
  values: string[],
): Generator<unknown> {
  yield {
    [commandBrand]: true,
    type: deleteType,
    table,
    values,
  } satisfies DeleteActionCmd;
}

export function* getCurrentTraits(): Generator<unknown, Trait[], unknown> {
  return (yield {
    [commandBrand]: true,
    type: getCurrentTraitsType,
  } satisfies GetCurrentTraitsCmd) as Trait[];
}

function* dispatchAction<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): Generator<DBCmd, TReturn> {
  const actionDB = withDriverTraceContextTrait(
    db,
    driverTraceContextFromFrameMeta(
      getGeneratorTraceMeta(action),
      getDriverTraceContextForDB(db),
    ),
  );
  const tx = yield* actionDB.beginTx();

  let isCommitted = false;
  try {
    const result = yield* runCommandGenerator(tx, action, {
      allowWrites: true,
    });

    yield* tx.commit();
    isCommitted = true;

    return result;
  } finally {
    if (!isCommitted) {
      yield* tx.rollback();
    }
  }
}

export function syncDispatch<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): TReturn {
  return execSync(dispatchAction(db, action));
}

/**
 * Dispatches an action and returns its result synchronously when no step
 * needed to wait (for example a HybridDB write served by the in-memory cache),
 * or a promise otherwise. Use it to avoid a microtask hop on sync fast paths.
 */
export function dispatchMaybeAsync<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): TReturn | Promise<TReturn> {
  return execMaybeAsync(dispatchAction(db, action));
}

export async function asyncDispatch<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): Promise<TReturn> {
  return dispatchMaybeAsync(db, action);
}
