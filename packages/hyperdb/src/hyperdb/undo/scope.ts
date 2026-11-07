import type { HyperDB } from "../core/contracts";
import type { Trait } from "../core/primitives";
import {
  runWithTraitsType,
  type RunWithTraitsCmd,
} from "../commands/action/commands";
import { commandBrand } from "../commands/brand";
import type { ActionGenerator } from "../commands/command-types";

export const skipUndoType = "hyperdb.undo.skip";
export const replayUndoType = "hyperdb.undo.replay";
export const undoGroupType = "hyperdb.undo.group";

export type UndoTrait = Trait & {
  manager?: object;
  group?: object;
  direction?: "undo" | "redo";
};

/** True for writes replayed by any undo manager, including writes from hooks. */
export function isUndoReplay(traits: readonly Trait[]): boolean {
  return traits.some((trait) => trait.type === replayUndoType);
}

export function* runInUndoScope<T>(
  body: () => ActionGenerator<T>,
  trait: UndoTrait,
): Generator<RunWithTraitsCmd, T, unknown> {
  return (yield {
    [commandBrand]: true,
    type: runWithTraitsType,
    traits: [trait],
    body: body(),
  } satisfies RunWithTraitsCmd) as T;
}

/** Skip history recording in every manager for a nested action block. */
export function withoutUndo<T>(
  body: () => ActionGenerator<T>,
): Generator<RunWithTraitsCmd, T, unknown>;
/** Skip history recording in every manager for writes through the scoped DB. */
export function withoutUndo<T>(db: HyperDB, body: (db: HyperDB) => T): T;
export function withoutUndo<T>(
  dbOrBody: HyperDB | (() => ActionGenerator<T>),
  body?: (db: HyperDB) => T,
): T | Generator<RunWithTraitsCmd, T, unknown> {
  const trait: UndoTrait = { type: skipUndoType };
  if (typeof dbOrBody === "function") {
    return runInUndoScope(dbOrBody, trait);
  }
  return body!(dbOrBody.withTraits(trait));
}
