import type { Row, Trait } from "../../core/primitives";
import type { TableDefinition } from "../../schema/table";
import { isCommandOfType, type CommandBrand } from "../brand";

export const insertType = "insert";
export const upsertType = "upsert";
export const deleteType = "delete";
export const getCurrentTraitsType = "getCurrentTraits";
export const runWithTraitsType = "runWithTraits";

export type RunWithTraitsCmd = CommandBrand & {
  type: typeof runWithTraitsType;
  traits: Trait[];
  body: Generator<unknown, unknown, unknown>;
};

export type InsertActionCmd = CommandBrand & {
  type: typeof insertType;
  table: TableDefinition;
  values: Row[];
};

export type UpsertActionCmd = CommandBrand & {
  type: typeof upsertType;
  table: TableDefinition;
  values: Row[];
};

export type DeleteActionCmd = CommandBrand & {
  type: typeof deleteType;
  table: TableDefinition;
  values: string[];
};

export type GetCurrentTraitsCmd = CommandBrand & {
  type: typeof getCurrentTraitsType;
};

export const isInsertActionCmd = (cmd: unknown): cmd is InsertActionCmd =>
  isCommandOfType(cmd, insertType);

export const isUpsertActionCmd = (cmd: unknown): cmd is UpsertActionCmd =>
  isCommandOfType(cmd, upsertType);

export const isDeleteActionCmd = (cmd: unknown): cmd is DeleteActionCmd =>
  isCommandOfType(cmd, deleteType);

export const isGetCurrentTraitsCmd = (
  cmd: unknown,
): cmd is GetCurrentTraitsCmd => isCommandOfType(cmd, getCurrentTraitsType);

export const isRunWithTraitsCmd = (cmd: unknown): cmd is RunWithTraitsCmd =>
  isCommandOfType(cmd, runWithTraitsType);
