import { runCommandGenerator } from "../runner";
import { execAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import type { Trait } from "../../core/primitives";
import { assertValid, v, type InferObject, type Validator } from "../../schema/values";
import type { ExtractSchema, TableDefinition } from "../../schema/table";
import { wrapGeneratorWithTraceMeta } from "../../tracing/metadata";
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

export * from "./commands";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ActionFn<TReturn, TParams extends any[]> = (
  ...args: TParams
) => Generator<unknown, TReturn, unknown>;

export type ActionArgsSchema = Record<string, Validator<any>>;
export type ActionFactoryOptions = {
  trace?: boolean;
  autoTrace?: boolean;
  validateArgs?: boolean;
};

export type ObjectAction<
  TReturn,
  TSchema extends ActionArgsSchema = ActionArgsSchema,
> = ((args: InferObject<TSchema>) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "action";
  readonly name: string;
  readonly args: TSchema;
  readonly trace?: boolean;
  readonly autoTrace?: boolean;
  readonly validateArgs?: boolean;
  readonly handler: (
    args: InferObject<TSchema>,
  ) => Generator<unknown, TReturn, unknown>;
};

export type ActionDefinition<TSchema extends ActionArgsSchema, TReturn> = {
  name: string;
  args: TSchema;
  handler: (
    args: InferObject<TSchema>,
  ) => Generator<unknown, TReturn, unknown>;
};

const defineActionMetadata = <
  TFn extends (...args: any[]) => Generator<unknown, unknown, unknown>,
>(
  fn: TFn,
  metadata: {
    name: string;
    args?: ActionArgsSchema;
    trace?: boolean;
    autoTrace?: boolean;
    validateArgs?: boolean;
    handler: (...args: any[]) => Generator<unknown, unknown, unknown>;
  },
): TFn => {
  Object.defineProperties(fn, {
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
      value: metadata.trace,
      enumerable: true,
      configurable: false,
    },
    autoTrace: {
      value: metadata.autoTrace,
      enumerable: true,
      configurable: false,
    },
    validateArgs: {
      value: metadata.validateArgs,
      enumerable: true,
      configurable: false,
    },
  });

  return fn;
};

const positionalTraceArg = (args: unknown[]): unknown => {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
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
  <TReturn, TParams extends any[]>(
    fn: ActionFn<TReturn, TParams>,
  ): ActionFn<TReturn, TParams>;
}

const defaultActionFactoryOptions: Required<ActionFactoryOptions> = {
  trace: false,
  autoTrace: true,
  validateArgs: false,
};

export function createAction(options: ActionFactoryOptions = {}): ActionBuilder {
  const factoryOptions = {
    ...defaultActionFactoryOptions,
    ...options,
  };

  const buildAction = <TReturn, TParams extends any[]>(
    input:
      | ActionDefinition<ActionArgsSchema, TReturn>
      | ActionFn<TReturn, TParams>,
  ): ActionFn<TReturn, TParams> => {
    if (typeof input !== "function") {
      const displayName = assertActionName(input.name);
      const argsValidator = v.object(input.args);
      const wrapped = ((args: InferObject<typeof input.args>) => {
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
            autoTrace: factoryOptions.autoTrace,
          },
        );
      }) as ObjectAction<TReturn, typeof input.args>;

      return defineActionMetadata(wrapped, {
        name: displayName,
        args: input.args,
        trace: factoryOptions.trace,
        autoTrace: factoryOptions.autoTrace,
        validateArgs: factoryOptions.validateArgs,
        handler: input.handler,
      }) as unknown as ActionFn<TReturn, TParams>;
    }

    const fn = input;
    const displayName = fn.name || "anonymous action";
    const wrapped = ((...args: TParams) =>
      wrapGeneratorWithTraceMeta(
        fn(...args),
        "action",
        displayName,
        positionalTraceArg(args),
        {
          trace: factoryOptions.trace,
          autoTrace: factoryOptions.autoTrace,
        },
      )) as ActionFn<TReturn, TParams>;

    return defineActionMetadata(wrapped, {
      name: displayName,
      trace: factoryOptions.trace,
      autoTrace: factoryOptions.autoTrace,
      validateArgs: factoryOptions.validateArgs,
      handler: fn as ActionFn<unknown, any[]>,
    }) as ActionFn<TReturn, TParams>;
  };

  return buildAction as ActionBuilder;
}

export const action = createAction();

export function* insert<TTable extends TableDefinition<any, any>>(
  table: TTable,
  values: ExtractSchema<TTable>[],
): Generator<unknown> {
  yield {
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
    type: deleteType,
    table,
    values,
  } satisfies DeleteActionCmd;
}

export function* getCurrentTraits(): Generator<unknown, Trait[], unknown> {
  return (yield {
    type: getCurrentTraitsType,
  } satisfies GetCurrentTraitsCmd) as Trait[];
}

export function syncDispatch<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): TReturn {
  const tx = execSync(db.beginTx());

  let isCommitted = false;
  try {
    const result = execSync(
      runCommandGenerator(tx, action, { allowWrites: true }),
    );

    execSync(tx.commit());
    isCommitted = true;

    return result;
  } finally {
    if (!isCommitted) {
      execSync(tx.rollback());
    }
  }
}

export async function asyncDispatch<TReturn>(
  db: HyperDB,
  action: Generator<unknown, TReturn, unknown>,
): Promise<TReturn> {
  const tx = await execAsync(db.beginTx());

  let isCommitted = false;
  try {
    const result = await execAsync(
      runCommandGenerator(tx, action, { allowWrites: true }),
    );

    await execAsync(tx.commit());
    isCommitted = true;

    return result;
  } finally {
    if (!isCommitted) {
      await execAsync(tx.rollback());
    }
  }
}
