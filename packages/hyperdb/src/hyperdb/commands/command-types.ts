import type { DBCmd } from "./async";
import type {
  DeleteActionCmd,
  GetCurrentTraitsCmd,
  InsertActionCmd,
  RunWithTraitsCmd,
  UpsertActionCmd,
} from "./action/commands";
import type { RunSelectorCmd, SelectRangeCmd } from "./selector/commands";

/** What a selector handler may yield: reads only. */
export type SelectorCommand =
  | SelectRangeCmd
  | RunSelectorCmd
  | GetCurrentTraitsCmd
  | DBCmd;

/** What an action handler may yield: reads, writes, and trait scopes. */
export type ActionCommand =
  | SelectorCommand
  | InsertActionCmd
  | UpsertActionCmd
  | DeleteActionCmd
  | RunWithTraitsCmd;

/** Return type for a reusable read helper used inside selectors or actions. */
export type SelectorGenerator<TReturn> = Generator<
  SelectorCommand,
  TReturn,
  unknown
>;

/** Return type for a reusable helper that may also write, used inside actions. */
export type ActionGenerator<TReturn> = Generator<
  ActionCommand,
  TReturn,
  unknown
>;
