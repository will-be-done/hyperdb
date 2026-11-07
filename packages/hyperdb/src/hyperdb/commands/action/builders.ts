/* eslint-disable @typescript-eslint/no-explicit-any */
import { runCommandGenerator } from "../runner";
import { execMaybeAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import type { DBCmd } from "../async";
import type { Trait } from "../../core/primitives";
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
import type { ActionGenerator } from "../command-types";
import {
  assertCommandName,
  createFactoryOptions,
  defineCommandMetadata,
  isTraceDisabled,
  normalizeTraceSkip,
  type CommandTraceSkip,
  type FactoryConfigureOptions,
} from "../builder-common";

export type ActionArgsSchema = Record<string, Validator<any>>;
export type ActionTraceSkip = CommandTraceSkip;
export type ActionFactoryOptions = {
  trace?: TraceOptions;
  validateArgs?: boolean;
};
export type ActionFactoryConfigureOptions = FactoryConfigureOptions;

export type ObjectAction<
  TReturn,
  TSchema extends ActionArgsSchema = ActionArgsSchema,
> = ((args: InferObject<TSchema>) => ActionGenerator<TReturn>) & {
  readonly kind: "action";
  readonly name: string;
  readonly args: TSchema;
  readonly skipTrace?: ActionTraceSkip;
  readonly trace: TraceOptions;
  readonly validateArgs?: boolean;
  readonly handler: (args: InferObject<TSchema>) => ActionGenerator<TReturn>;
};

export type ActionDefinition<TSchema extends ActionArgsSchema, TReturn> = {
  name: string;
  args: TSchema;
  skipTrace?: ActionTraceSkip;
  handler: (args: InferObject<TSchema>) => ActionGenerator<TReturn>;
};

export interface ActionBuilder {
  <TSchema extends ActionArgsSchema, TReturn>(
    definition: ActionDefinition<TSchema, TReturn>,
  ): ObjectAction<TReturn, TSchema>;
  configure(options: ActionFactoryConfigureOptions): void;
}

export function createAction(
  options: ActionFactoryOptions = {},
): ActionBuilder {
  const factory = createFactoryOptions(options);
  const factoryOptions = factory.current;

  const buildAction = <TSchema extends ActionArgsSchema, TReturn>(
    input: ActionDefinition<TSchema, TReturn>,
  ): ObjectAction<TReturn, TSchema> => {
    const displayName = assertCommandName("Action", input.name);
    const argsValidator = v.object(input.args);
    const skipTrace = normalizeTraceSkip(input.skipTrace);
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

    return defineCommandMetadata(wrapped, "action", {
      name: displayName,
      args: input.args,
      skipTrace: input.skipTrace,
      trace: () => factoryOptions.trace,
      validateArgs: () => factoryOptions.validateArgs,
      handler: input.handler,
    });
  };

  const builder = buildAction as ActionBuilder;
  builder.configure = factory.configure;

  return builder;
}

export function* insert<TTable extends TableDefinition<any, any>>(
  table: TTable,
  values: ExtractSchema<TTable>[],
): Generator<InsertActionCmd, void, unknown> {
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
): Generator<UpsertActionCmd, void, unknown> {
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
): Generator<DeleteActionCmd, void, unknown> {
  yield {
    [commandBrand]: true,
    type: deleteType,
    table,
    values,
  } satisfies DeleteActionCmd;
}

export function* getCurrentTraits(): Generator<
  GetCurrentTraitsCmd,
  Trait[],
  unknown
> {
  return (yield {
    [commandBrand]: true,
    type: getCurrentTraitsType,
  } satisfies GetCurrentTraitsCmd) as Trait[];
}

function* dispatchAction<TReturn>(
  db: HyperDB,
  action: ActionGenerator<TReturn>,
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
  action: ActionGenerator<TReturn>,
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
  action: ActionGenerator<TReturn>,
): TReturn | Promise<TReturn> {
  return execMaybeAsync(dispatchAction(db, action));
}

export async function asyncDispatch<TReturn>(
  db: HyperDB,
  action: ActionGenerator<TReturn>,
): Promise<TReturn> {
  return dispatchMaybeAsync(db, action);
}
