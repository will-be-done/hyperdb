import type { Row, Tuple, TupleScanOptions } from "../../core/primitives";
import type { Op } from "../../runtime/ops";
import { isTupleInBounds, normalizeTupleBounds } from "../../core/query/tuple";
import { type SelectRangeCmd } from "./commands";

type IndexCols = readonly PropertyKey[];

// The rows an op can move in or out of a range, and their tuples per index,
// built the first time a selector reading that index checks the op.
type PreparedOp = { rows: Row[]; tuples: Map<IndexCols, Tuple[]> };

type OpsByTable = { length: number; byTable: Map<string, PreparedOp[]> };

const opsByTableCache = new WeakMap<Op[], OpsByTable>();

const rowsOf = (op: Op): Row[] => {
  switch (op.type) {
    case "insert":
      return [op.newValue];
    case "upsert":
      return op.oldValue === undefined
        ? [op.newValue]
        : [op.oldValue, op.newValue];
    case "delete":
      return [op.oldValue];
  }
};

// Every subscriber of a commit receives the same ops array, so grouping it
// once lets each selector skip ops on tables it never read, and lets all of
// them share the row tuples. HyperDB never changes the array after notifying,
// but a subscriber could, so a different length forces a regroup. Groups are
// keyed by table name so equivalent table definitions invalidate each other.
const groupOpsByTable = (ops: Op[]): Map<string, PreparedOp[]> => {
  const cached = opsByTableCache.get(ops);
  if (cached && cached.length === ops.length) return cached.byTable;

  const byTable = new Map<string, PreparedOp[]>();
  for (const op of ops) {
    let tableOps = byTable.get(op.table.tableName);
    if (!tableOps) {
      tableOps = [];
      byTable.set(op.table.tableName, tableOps);
    }
    tableOps.push({ rows: rowsOf(op), tuples: new Map() });
  }
  opsByTableCache.set(ops, { length: ops.length, byTable });
  return byTable;
};

const tuplesOf = (op: PreparedOp, cols: IndexCols): Tuple[] => {
  let tuples = op.tuples.get(cols);
  if (!tuples) {
    tuples = op.rows.map(
      (row) => cols.map((col) => row[col as string]) as Tuple,
    );
    op.tuples.set(cols, tuples);
  }
  return tuples;
};

type NormalizedBound = { tupleCount: number; bounds: TupleScanOptions };

// A cached selector keeps its range commands for its whole life and checks
// them on every commit, so each bound is padded to the index width once.
const normalizedBoundCache = new WeakMap<TupleScanOptions, NormalizedBound>();

const normalizedBound = (
  bound: TupleScanOptions,
  tupleCount: number,
): TupleScanOptions => {
  const cached = normalizedBoundCache.get(bound);
  if (cached && cached.tupleCount === tupleCount) return cached.bounds;

  const bounds = normalizeTupleBounds(bound, tupleCount);
  normalizedBoundCache.set(bound, { tupleCount, bounds });
  return bounds;
};

// TODO: maybe range tree instead?
export const isNeedToRerunRange = (
  cmds: SelectRangeCmd[],
  ops: Op[],
): boolean => {
  if (cmds.length === 0 || ops.length === 0) return false;
  const opsByTable = groupOpsByTable(ops);

  for (const cmd of cmds) {
    const tableOps = opsByTable.get(cmd.table.tableName);
    if (!tableOps) continue;

    const cols = cmd.table.indexes[cmd.index].cols;
    for (const bound of cmd.bounds) {
      const bounds = normalizedBound(bound, cols.length);
      for (const op of tableOps) {
        for (const tuple of tuplesOf(op, cols)) {
          if (isTupleInBounds(tuple, bounds)) return true;
        }
      }
    }
  }

  return false;
};

const isPlainSerializableObject = (
  value: object,
): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const bytesOfBinaryValue = (value: ArrayBuffer | ArrayBufferView): number[] => {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }

  return Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
};

const serializeBytes = (bytes: number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

const serializeStablePrimitiveValue = (
  value: unknown,
  path: string,
): string | undefined => {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `Cannot serialize selector args at ${path}: number must be finite`,
        );
      }
      if (Object.is(value, -0)) {
        return "number:-0";
      }
      return `number:${String(value)}`;
    case "boolean":
      return `boolean:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "undefined":
      throw new Error(
        `Cannot serialize selector args at ${path}: undefined is not supported`,
      );
    case "function":
      throw new Error(
        `Cannot serialize selector args at ${path}: functions are not supported`,
      );
    case "symbol":
      throw new Error(
        `Cannot serialize selector args at ${path}: symbols are not supported`,
      );
    case "object":
      return undefined;
  }
};

const serializeStableValue = (
  value: unknown,
  stack: WeakSet<object>,
  path: string,
): string => {
  const primitive = serializeStablePrimitiveValue(value, path);
  if (primitive !== undefined) return primitive;

  if (value instanceof ArrayBuffer) {
    return `arrayBuffer:${serializeBytes(bytesOfBinaryValue(value))}`;
  }

  if (ArrayBuffer.isView(value)) {
    return [
      "arrayBufferView",
      value.constructor.name,
      String(value.byteOffset),
      String(value.byteLength),
      serializeBytes(bytesOfBinaryValue(value)),
    ].join(":");
  }

  if (typeof value !== "object" || value === null) {
    throw new Error(
      `Cannot serialize selector args at ${path}: unsupported value type`,
    );
  }

  if (stack.has(value)) {
    throw new Error(
      `Cannot serialize selector args at ${path}: circular reference`,
    );
  }

  stack.add(value);

  try {
    if (Array.isArray(value)) {
      const expectedKeys = new Set(
        Array.from({ length: value.length }, (_, index) => String(index)),
      );
      const extraKey = Object.keys(value).find((key) => !expectedKeys.has(key));
      if (extraKey !== undefined) {
        throw new Error(
          `Cannot serialize selector args at ${path}: array properties are not supported`,
        );
      }

      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length > 0) {
        throw new Error(
          `Cannot serialize selector args at ${path}: symbol keys are not supported`,
        );
      }

      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) {
          throw new Error(
            `Cannot serialize selector args at ${path}[${index}]: sparse arrays are not supported`,
          );
        }

        items.push(
          serializeStableValue(value[index], stack, `${path}[${index}]`),
        );
      }
      return `array:[${items.join(",")}]`;
    }

    if (!isPlainSerializableObject(value)) {
      throw new Error(
        `Cannot serialize selector args at ${path}: unsupported object type`,
      );
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new Error(
        `Cannot serialize selector args at ${path}: symbol keys are not supported`,
      );
    }

    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => {
      const serializedKey = JSON.stringify(key);
      const serializedValue = serializeStableValue(
        value[key],
        stack,
        `${path}.${key}`,
      );
      return `${serializedKey}:${serializedValue}`;
    });

    return `object:{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
};

export const stableSerializeSelectorArgs = (args: unknown): string =>
  serializeStablePrimitiveValue(args, "$") ??
  serializeStableValue(args, new WeakSet(), "$");
