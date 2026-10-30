import type { HyperDB } from "../core/contracts";
import type { Trait } from "../core/primitives";
import {
  runWithTraitsType,
  type RunWithTraitsCmd,
} from "../commands/action/commands";

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
  body: () => Generator<unknown, T, unknown>,
  trait: UndoTrait,
): Generator<unknown, T, unknown> {
  return (yield {
    type: runWithTraitsType,
    traits: [trait],
    body: body(),
  } satisfies RunWithTraitsCmd) as T;
}

/** Skip history recording in every manager for a nested action block. */
export function withoutUndo<T>(
  body: () => Generator<unknown, T, unknown>,
): Generator<unknown, T, unknown>;
/** Skip history recording in every manager for writes through the scoped DB. */
export function withoutUndo<T>(db: HyperDB, body: (db: HyperDB) => T): T;
export function withoutUndo<T>(
  dbOrBody: HyperDB | (() => Generator<unknown, T, unknown>),
  body?: (db: HyperDB) => T,
): T | Generator<unknown, T, unknown> {
  const trait: UndoTrait = { type: skipUndoType };
  if (typeof dbOrBody === "function") {
    return runInUndoScope(dbOrBody, trait);
  }
  return body!(dbOrBody.withTraits(trait));
}
