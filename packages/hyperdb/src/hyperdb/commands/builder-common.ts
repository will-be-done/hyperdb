/* eslint-disable @typescript-eslint/no-explicit-any */
// Pieces shared by createAction() and createSelector().
import { defaultTraceOptions, type TraceOptions } from "../core/tracer";

export type CommandTraceSkip =
  | boolean
  | {
      childTrace: boolean;
      rootTrace: boolean;
    };

export type NormalizedTraceSkip = {
  childTrace: boolean;
  rootTrace: boolean;
};

export const normalizeTraceSkip = (
  skipTrace: CommandTraceSkip | undefined,
): NormalizedTraceSkip => {
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

export const isTraceDisabled = (trace: TraceOptions): boolean => !trace.enabled;

export const assertCommandName = (
  label: "Action" | "Selector",
  name: unknown,
): string => {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${label} name is required`);
  }

  return name;
};

export type FactoryOptions = {
  trace: TraceOptions;
  validateArgs: boolean;
};

export type FactoryConfigureOptions = {
  trace?: Partial<TraceOptions>;
  validateArgs?: boolean;
};

/**
 * Mutable factory options. Commands read them lazily, so `configure()` also
 * changes commands the builder already created.
 */
export const createFactoryOptions = (
  options: { trace?: TraceOptions; validateArgs?: boolean } = {},
): {
  current: FactoryOptions;
  configure(nextOptions: FactoryConfigureOptions): void;
} => {
  const current: FactoryOptions = {
    validateArgs: options.validateArgs ?? false,
    trace: { ...defaultTraceOptions, ...options.trace },
  };

  return {
    current,
    configure(nextOptions) {
      if (nextOptions.trace !== undefined) {
        current.trace = { ...current.trace, ...nextOptions.trace };
      }
      if (nextOptions.validateArgs !== undefined) {
        current.validateArgs = nextOptions.validateArgs;
      }
    },
  };
};

/** Attaches the read-only metadata (`kind`, `name`, `args`, ...) to a command fn. */
export const defineCommandMetadata = <
  TFn extends (...args: any[]) => Generator<unknown, unknown, unknown>,
>(
  fn: TFn,
  kind: "action" | "selector",
  metadata: {
    name: string;
    args?: unknown;
    skipTrace?: CommandTraceSkip;
    trace: () => TraceOptions;
    validateArgs: () => boolean;
    handler: (...args: any[]) => Generator<unknown, unknown, unknown>;
  },
  extra: Record<string, unknown> = {},
): TFn => {
  const descriptors: PropertyDescriptorMap = {
    kind: {
      value: kind,
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
      get: metadata.trace,
      enumerable: true,
      configurable: false,
    },
    validateArgs: {
      get: metadata.validateArgs,
      enumerable: true,
      configurable: false,
    },
  };

  for (const [key, value] of Object.entries(extra)) {
    descriptors[key] = { value, enumerable: true, configurable: false };
  }

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
