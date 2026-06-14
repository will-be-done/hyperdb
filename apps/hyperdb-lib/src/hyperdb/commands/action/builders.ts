import { runCommandGenerator } from "../runner";
import { execAsync, execSync } from "../../core/executor";
import type { HyperDB } from "../../core/contracts";
import type { Trait } from "../../core/primitives";
import type { InferObject, Validator } from "../../schema/values";
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

export type ObjectAction<
  TArgs,
  TReturn,
  TSchema extends ActionArgsSchema = ActionArgsSchema,
> = ((args: TArgs) => Generator<unknown, TReturn, unknown>) & {
  readonly kind: "action";
  readonly name: string;
  readonly args: TSchema;
  readonly handler: (args: TArgs) => Generator<unknown, TReturn, unknown>;
};

export type ActionDefinition<TSchema extends ActionArgsSchema, TReturn> = {
  name?: string;
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
  });

  return fn;
};

const positionalTraceArg = (args: unknown[]): unknown => {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
};

export function action<TSchema extends ActionArgsSchema, TReturn>(
  definition: ActionDefinition<TSchema, TReturn>,
): ObjectAction<InferObject<TSchema>, TReturn, TSchema>;
export function action<TReturn, TParams extends any[]>(
  fn: ActionFn<TReturn, TParams>,
): ActionFn<TReturn, TParams>;
export function action<TReturn, TParams extends any[]>(
  input: ActionDefinition<ActionArgsSchema, TReturn> | ActionFn<TReturn, TParams>,
): ActionFn<TReturn, TParams> {
  if (typeof input !== "function") {
    const displayName = input.name || input.handler.name || "anonymous action";
    const wrapped = ((args: InferObject<typeof input.args>) =>
      wrapGeneratorWithTraceMeta(
        input.handler(args),
        "action",
        displayName,
        args,
      )) as ObjectAction<InferObject<typeof input.args>, TReturn, typeof input.args>;

    return defineActionMetadata(wrapped, {
      name: displayName,
      args: input.args,
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
    )) as ActionFn<TReturn, TParams>;

  return defineActionMetadata(wrapped, {
    name: displayName,
    handler: fn as ActionFn<unknown, any[]>,
  }) as ActionFn<TReturn, TParams>;
}

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
