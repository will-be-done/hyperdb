import type { Row } from "../core/primitives";
import type { TableDefinition } from "../schema/table";

export type InsertOp = {
  type: "insert";
  table: TableDefinition;
  newValue: Row;
};

export type UpsertOp = {
  type: "upsert";
  table: TableDefinition;
  oldValue?: Row;
  newValue: Row;
};

export type DeleteOp = {
  type: "delete";
  table: TableDefinition;
  oldValue: Row;
};

export type Op = InsertOp | UpsertOp | DeleteOp;
