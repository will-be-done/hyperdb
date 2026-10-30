import type { Row } from "../core/primitives";

// Compare stored values, including bigint and binary, without JSON coercions.
export function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  const aBinary = bytes(a);
  const bBinary = bytes(b);
  if (aBinary || bBinary) {
    return (
      !!aBinary &&
      !!bBinary &&
      aBinary.length === bBinary.length &&
      aBinary.every((value, index) => value === bBinary[index])
    );
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equalValues(left[key], right[key]),
    )
  );
}

function bytes(value: object): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export function copyRow(row: Row | undefined): Row | undefined {
  return row === undefined ? undefined : structuredClone(row);
}
