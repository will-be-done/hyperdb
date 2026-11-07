import { HyperDBError } from "./core/errors";

export class UnreachableError extends Error {
  constructor(obj: never, message?: string) {
    super((message + ": " || "Unreachable: ") + obj);
  }
}

export type RefVar<T> = { val: T };
export const refVar = <T>(val: T): RefVar<T> => ({
  val,
});

// The error every closed HyperDB raises.
export const dbClosedError = (): HyperDBError =>
  new HyperDBError("DB_CLOSED", "DB is closed");
