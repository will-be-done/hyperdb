import { isNoopCmd, isUnwrapCmd, type DBCmd } from "../commands/async";

function unexpectedCmdError(cmd: unknown): Error {
  return new Error(`Unexpected DBCmd yielded: ${String(cmd)}`);
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

  while (!result.done) {
    if (isUnwrapCmd(result.value)) {
      throw new Error("Cannot execute async commands");
    } else if (isNoopCmd(result.value)) {
      result = cmd.next();
    } else {
      throw unexpectedCmdError(result.value);
    }
  }

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
