import { commandBrand, isCommandOfType, type CommandBrand } from "./brand";

const unwrapType = "unwrap";
const noopType = "noop";
type NoopCmd = CommandBrand & { type: typeof noopType };
type UnwrapCmd = CommandBrand & {
  type: typeof unwrapType;
  data: unknown | Promise<unknown>;
};
export type DBCmd = UnwrapCmd | NoopCmd;

export function* unwrap<T>(data: Promise<T>): Generator<DBCmd, T, unknown> {
  return (yield {
    [commandBrand]: true,
    type: unwrapType,
    data: data,
  } satisfies UnwrapCmd) as T;
}

export function* unwrapCb<T>(
  data: () => Promise<T>,
): Generator<DBCmd, T, unknown> {
  return (yield {
    [commandBrand]: true,
    type: unwrapType,
    data: data(),
  } satisfies UnwrapCmd) as T;
}

export function* noop(): Generator<DBCmd, void, unknown> {
  return (yield {
    [commandBrand]: true,
    type: noopType,
  } satisfies NoopCmd) as void;
}

export const isUnwrapCmd = (cmd: unknown): cmd is UnwrapCmd =>
  isCommandOfType(cmd, unwrapType);

export const isNoopCmd = (cmd: unknown): cmd is NoopCmd =>
  isCommandOfType(cmd, noopType);
