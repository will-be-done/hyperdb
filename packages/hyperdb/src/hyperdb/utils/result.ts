// The only module that imports neverthrow. Results are internal: public
// functions, exported types, and the HyperDB/DBDriver contracts never expose
// them, so convert with `unwrapOrThrow` at the boundary. neverthrow's
// generator helpers (`safeTry`, `safeUnwrap`, `yield*` on a Result) are not
// re-exported: HyperDB's own generators yield DB commands, and a yielded Err
// would reach the command executor.
import type { Result } from "neverthrow";

export {
  err,
  errAsync,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  ok,
  okAsync,
  Result,
  ResultAsync,
} from "neverthrow";
export type { Err, Ok } from "neverthrow";

export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
