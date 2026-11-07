import type { Op } from "../../runtime/ops";
import { isRowInRange } from "../../core/query/tuple";
import { type SelectRangeCmd } from "./commands";

const opsByTableCache = new WeakMap<Op[], Map<Op["table"], Op[]>>();

// Every subscriber of a commit receives the same, already-final ops array, so
// grouping it once lets each selector skip ops on tables it never read.
const groupOpsByTable = (ops: Op[]): Map<Op["table"], Op[]> => {
  let byTable = opsByTableCache.get(ops);
  if (byTable) return byTable;

  byTable = new Map();
  for (const op of ops) {
    let tableOps = byTable.get(op.table);
    if (!tableOps) {
      tableOps = [];
      byTable.set(op.table, tableOps);
    }
    tableOps.push(op);
  }
  opsByTableCache.set(ops, byTable);
  return byTable;
};

const isOpInRange = (
  op: Op,
  cmd: SelectRangeCmd,
  bound: SelectRangeCmd["bounds"][number],
): boolean => {
  switch (op.type) {
    case "insert":
      return isRowInRange(op.newValue, cmd.table, cmd.index, bound);
    case "upsert":
      return (
        (op.oldValue !== undefined &&
          isRowInRange(op.oldValue, cmd.table, cmd.index, bound)) ||
        isRowInRange(op.newValue, cmd.table, cmd.index, bound)
      );
    case "delete":
      return isRowInRange(op.oldValue, cmd.table, cmd.index, bound);
  }
};

// TODO: maybe range tree instead?
export const isNeedToRerunRange = (
  cmds: SelectRangeCmd[],
  ops: Op[],
): boolean => {
  if (cmds.length === 0 || ops.length === 0) return false;
  const opsByTable = groupOpsByTable(ops);

  for (const cmd of cmds) {
    const tableOps = opsByTable.get(cmd.table);
    if (!tableOps) continue;

    for (const bound of cmd.bounds) {
      for (const op of tableOps) {
        if (isOpInRange(op, cmd, bound)) return true;
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
