import { MAX, MIN, type Row } from "../../core/primitives";
import { UnreachableError } from "../../utils";

export type SqliteSortKeyMode = "scan" | "stored";

const MAX_DECIMAL_LENGTH = 999999999999999;
const TERMINATOR = 0x00;
const TAG = {
  min: 0x10,
  missing: 0x20,
  null: 0x30,
  bigint: 0x40,
  number: 0x50,
  boolean: 0x60,
  string: 0x70,
  bytes: 0x80,
  array: 0x90,
  object: 0xa0,
  max: 0xff,
} as const;

function isEncodedObject(
  value: unknown,
): value is { $hyperdbType?: unknown; value?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value)
  );
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (byte) =>
        Number.isInteger(byte) &&
        Number.isFinite(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  );
}

function isEncodedBytesObject(value: unknown): value is {
  $hyperdbType: "arrayBuffer" | "bytes";
  value: number[];
} {
  return (
    isEncodedObject(value) &&
    (value.$hyperdbType === "arrayBuffer" || value.$hyperdbType === "bytes") &&
    isByteArray(value.value)
  );
}

function bytesOf(value: unknown): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (isEncodedBytesObject(value)) {
    return value.value;
  }
  return [];
}

function bigintOf(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (
    isEncodedObject(value) &&
    value.$hyperdbType === "bigint" &&
    typeof value.value === "string"
  ) {
    return BigInt(value.value);
  }
  throw new UnreachableError(value as never, "Expected bigint value");
}

function asciiBytes(value: string): number[] {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function encodeBigintPayload(value: unknown): number[] {
  const bigint = bigintOf(value);
  const negative = bigint < 0n;
  const digits = (negative ? -bigint : bigint).toString();
  if (digits.length > MAX_DECIMAL_LENGTH) {
    throw new Error("BigInt is too large to encode as a SQLite sort key");
  }

  if (!negative) {
    return asciiBytes(
      `1${digits.length.toString().padStart(15, "0")}${digits}`,
    );
  }

  const invertedLength = MAX_DECIMAL_LENGTH - digits.length;
  const invertedDigits = digits
    .split("")
    .map((digit) => String(9 - Number(digit)))
    .join("");

  return asciiBytes(
    `0${invertedLength.toString().padStart(15, "0")}${invertedDigits}`,
  );
}

function encodeNumberPayload(value: number): number[] {
  const normalized = Object.is(value, -0) ? 0 : value;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, normalized, false);
  const bytes = Array.from(new Uint8Array(buffer));

  if ((bytes[0]! & 0x80) !== 0) {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = ~bytes[i]! & 0xff;
    }
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }

  return bytes;
}

// Encodes positive integers from 1 through 0x3fffff inclusive with the same
// bytewise order as their numeric value. Zero is reserved as a terminator;
// callers must keep values within the supported range.
function encodePositiveInteger(value: number): number[] {
  if (value <= 0x7f) return [value];
  if (value <= 0x7ff) {
    return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
  }
  if (value <= 0xffff) {
    return [
      0xe0 | (value >> 12),
      0x80 | ((value >> 6) & 0x3f),
      0x80 | (value & 0x3f),
    ];
  }
  return [
    0xf0 | (value >> 18),
    0x80 | ((value >> 12) & 0x3f),
    0x80 | ((value >> 6) & 0x3f),
    0x80 | (value & 0x3f),
  ];
}

function encodeStringPayload(value: string): number[] {
  const result: number[] = [];
  for (let index = 0; index < value.length; index++) {
    result.push(...encodePositiveInteger(value.charCodeAt(index) + 1));
  }
  result.push(TERMINATOR);
  return result;
}

function encodeByteArrayPayload(bytes: readonly number[]): number[] {
  const result: number[] = [];
  for (const byte of bytes) {
    result.push(...encodePositiveInteger(byte + 1));
  }
  result.push(TERMINATOR);
  return result;
}

function encodeArrayPayload(values: readonly unknown[]): number[] {
  return [...values.flatMap((item) => encodeStoredSortValue(item)), TERMINATOR];
}

function encodeObjectPayload(value: Record<string, unknown>): number[] {
  const keys = Object.keys(value).sort();
  return [
    ...encodeArrayPayload(keys),
    ...keys.flatMap((key) => encodeStoredSortValue(value[key])),
    TERMINATOR,
  ];
}

function encodeScanSortValue(value: unknown): number[] {
  if (value === MIN) return [TAG.min];
  if (value === MAX) return [TAG.max];
  if (value === null || value === undefined) return [TAG.null];
  if (
    typeof value === "bigint" ||
    (isEncodedObject(value) &&
      value.$hyperdbType === "bigint" &&
      typeof value.value === "string")
  ) {
    return [TAG.bigint, ...encodeBigintPayload(value)];
  }
  if (typeof value === "number") {
    return [TAG.number, ...encodeNumberPayload(value)];
  }
  if (typeof value === "boolean") {
    return [TAG.number, ...encodeNumberPayload(Number(value))];
  }
  if (typeof value === "string") {
    return [TAG.string, ...encodeStringPayload(value)];
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isEncodedBytesObject(value)
  ) {
    return [TAG.bytes, ...encodeByteArrayPayload(bytesOf(value))];
  }

  throw new UnreachableError(value as never, "Unknown scan sort-key value");
}

function encodeStoredSortValue(value: unknown): number[] {
  if (value === MIN) return [TAG.min];
  if (value === MAX) return [TAG.max];
  if (value === undefined) return [TAG.missing];
  if (value === null) return [TAG.null];

  if (
    typeof value === "bigint" ||
    (isEncodedObject(value) &&
      value.$hyperdbType === "bigint" &&
      typeof value.value === "string")
  ) {
    return [TAG.bigint, ...encodeBigintPayload(value)];
  }
  if (typeof value === "number") {
    return [TAG.number, ...encodeNumberPayload(value)];
  }
  if (typeof value === "boolean") {
    return [TAG.boolean, value ? 1 : 0];
  }
  if (typeof value === "string") {
    return [TAG.string, ...encodeStringPayload(value)];
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isEncodedBytesObject(value)
  ) {
    return [TAG.bytes, ...encodeByteArrayPayload(bytesOf(value))];
  }
  if (Array.isArray(value)) {
    return [TAG.array, ...encodeArrayPayload(value)];
  }
  if (isEncodedObject(value)) {
    return [TAG.object, ...encodeObjectPayload(value)];
  }

  throw new UnreachableError(value as never, "Unknown stored sort-key value");
}

export function encodeSqliteSortKeyTuple(
  tuple: readonly unknown[],
  mode: SqliteSortKeyMode,
): Uint8Array {
  const encodeValue =
    mode === "stored" ? encodeStoredSortValue : encodeScanSortValue;
  return Uint8Array.from(tuple.flatMap((value) => encodeValue(value)));
}

export function getSqliteSortKeyTuple(
  row: Row,
  indexColumns: readonly string[],
  includeMissing: boolean,
): unknown[] | undefined {
  const values: unknown[] = [];

  for (const col of indexColumns) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) {
      if (!includeMissing) return undefined;
      values.push(undefined);
      continue;
    }

    const value = row[col];
    values.push(value === undefined && !includeMissing ? null : value);
  }

  return values;
}
