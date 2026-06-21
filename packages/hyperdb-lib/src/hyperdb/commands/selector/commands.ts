import type { TupleScanOptions, Value } from "../../core/primitives";
import type { AnyTableDefinition } from "../../schema/table";

const selectRangeType = "selectRange";

export type QueryWhereClause = {
  lt: { col: string; val: Value }[];
  lte: { col: string; val: Value }[];
  gt: { col: string; val: Value }[];
  gte: { col: string; val: Value }[];
  eq: { col: string; val: Value }[];
};

export type QueryOrder = "asc" | "desc";

export type SelectQuery<
  TTable extends AnyTableDefinition = AnyTableDefinition,
  K extends string | number = string | number,
> = {
  limit?: number;
  order?: QueryOrder;
  from: TTable;
  index: K;
  where: QueryWhereClause[];
};

export type SelectRangeCmd = {
  type: typeof selectRangeType;
  table: AnyTableDefinition;
  index: string;
  selectQuery: SelectQuery;
  bounds: TupleScanOptions[];
};

export const isSelectRangeCmd = (cmd: unknown): cmd is SelectRangeCmd =>
  typeof cmd === "object" &&
  cmd !== null &&
  typeof (cmd as { type?: unknown }).type === "string" &&
  (cmd as { type?: unknown }).type === selectRangeType;

const runSelectorType = "runSelector";

export type SelectorMemoization = {
  root: boolean;
  selfChild: boolean;
};

/**
 * Marker yielded by a `selector()` wrapper so the runner can decide whether to
 * run the selector body or reuse a memoized result. The body is created lazily
 * via `makeBody` so a cache hit avoids constructing the generator at all.
 */
export type RunSelectorCmd = {
  type: typeof runSelectorType;
  // Identity for the memo map (the wrapped selector fn).
  selector: object;
  // Args used both for the memo key and trace metadata.
  args: unknown;
  // Raw handler invocation, run only on a cache miss.
  makeBody: () => Generator<unknown, unknown, unknown>;
  // Display name for trace frames.
  name: string;
  memoization?: SelectorMemoization;
  skipTrace?: {
    childTrace: boolean;
    rootTrace: boolean;
  };
};

export const isRunSelectorCmd = (cmd: unknown): cmd is RunSelectorCmd =>
  typeof cmd === "object" &&
  cmd !== null &&
  (cmd as { type?: unknown }).type === runSelectorType;
