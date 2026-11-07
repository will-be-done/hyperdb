import { isNoopCmd, isUnwrapCmd, type DBCmd } from "../commands/async";
import { HyperDBError } from "./errors";

const syncErrorHandler = Symbol("syncErrorHandler");
type ObservedCommand = DBCmd & {
  [syncErrorHandler]?: (error: HyperDBError) => void;
};

/** @internal Observe executor aborts before a driver can catch them. */
export function* observeSyncExecution<T>(
  cmd: Generator<DBCmd, T, unknown>,
  onError: (error: HyperDBError) => void,
): Generator<DBCmd, T, unknown> {
  const observe = (
    result: IteratorResult<DBCmd, T>,
  ): IteratorResult<DBCmd, T> => {
    if (result.done || !isUnwrapCmd(result.value)) return result;
    const previous = (result.value as ObservedCommand)[syncErrorHandler];
    const value: ObservedCommand = {
      ...result.value,
      [syncErrorHandler]: (error) => {
        previous?.(error);
        onError(error);
      },
    };
    return { done: false, value };
  };
  // Delegate all three iterator methods so abandonment still runs cleanup.
  return yield* {
    [Symbol.iterator]() {
      return {
        next: (value?: unknown) => observe(cmd.next(value)),
        throw: (error: unknown) => observe(cmd.throw(error)),
        return: (value: T) => observe(cmd.return(value)),
      };
    },
  };
}

function unexpectedCmdError(cmd: unknown): Error {
  return new HyperDBError(
    "UNSUPPORTED_COMMAND",
    `Unexpected DBCmd yielded: ${String(cmd)}`,
  );
}

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> => {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }

  return typeof (value as { then?: unknown }).then === "function";
};

export function execSync<T>(cmd: Generator<DBCmd, T>): T {
  let result = cmd.next();
  let asyncError: HyperDBError | undefined;

  while (!result.done) {
    if (isUnwrapCmd(result.value)) {
      // The promise is abandoned here; observe it so a later rejection (for
      // example an async rollback) is not reported as unhandled.
      const data = result.value.data;
      if (isPromiseLike(data)) data.then(undefined, () => {});
      // Throw into the generator so its finally blocks (such as a transaction
      // rollback) still run before the error reaches the caller.
      asyncError ??= new HyperDBError(
        "ASYNC_IN_SYNC_EXECUTION",
        "Cannot execute async commands",
      );
      (result.value as ObservedCommand)[syncErrorHandler]?.(asyncError);
      try {
        result = cmd.throw(asyncError);
      } catch {
        // A replacement thrown during cleanup cannot hide the sync abort.
        throw asyncError;
      }
    } else if (isNoopCmd(result.value)) {
      result = cmd.next();
    } else {
      throw unexpectedCmdError(result.value);
    }
  }

  // A generator that catches the error must not turn the aborted run into a
  // normal result.
  if (asyncError) throw asyncError;

  return result.value as T;
}

async function execAsyncFrom<T>(
  cmd: Generator<DBCmd, T>,
  value: unknown,
): Promise<T> {
  let result = await resumeAfterAsyncCommand(cmd, value);

  while (!result.done) {
    if (isUnwrapCmd(result.value)) {
      result = await resumeAfterAsyncCommand(cmd, result.value.data);
    } else if (isNoopCmd(result.value)) {
      result = cmd.next();
    } else {
      throw unexpectedCmdError(result.value);
    }
  }

  return result.value as T;
}

async function resumeAfterAsyncCommand<T>(
  cmd: Generator<DBCmd, T>,
  data: unknown,
): Promise<IteratorResult<DBCmd, T>> {
  let value: unknown;
  try {
    value = await data;
  } catch (error) {
    return cmd.throw(error);
  }

  return cmd.next(value);
}

export async function execAsync<T>(cmd: Generator<DBCmd, T>): Promise<T> {
  let result = cmd.next();

  while (!result.done) {
    if (isUnwrapCmd(result.value)) {
      result = await resumeAfterAsyncCommand(cmd, result.value.data);
    } else if (isNoopCmd(result.value)) {
      result = cmd.next();
    } else {
      throw unexpectedCmdError(result.value);
    }
  }

  return result.value as T;
}

export function execMaybeAsync<T>(cmd: Generator<DBCmd, T>): T | Promise<T> {
  let result = cmd.next();

  while (!result.done) {
    if (isUnwrapCmd(result.value)) {
      const data = result.value.data;
      if (isPromiseLike(data)) {
        return execAsyncFrom(cmd, data);
      }
      result = cmd.next(data);
    } else if (isNoopCmd(result.value)) {
      result = cmd.next();
    } else {
      throw unexpectedCmdError(result.value);
    }
  }

  return result.value as T;
}
