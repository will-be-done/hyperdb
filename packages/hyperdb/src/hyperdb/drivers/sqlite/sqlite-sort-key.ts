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

// Keys are written into one scratch buffer and copied out once per tuple, so
// encoding allocates little beyond the returned key.
const INITIAL_BUFFER_SIZE = 256;
// A buffer grown past this by an unusually large key is not kept around.
const MAX_RETAINED_BUFFER_SIZE = 64 * 1024;
let buffer = new Uint8Array(INITIAL_BUFFER_SIZE);
let length = 0;
const numberView = new DataView(new ArrayBuffer(8));

function reserve(extra: number): void {
  const needed = length + extra;
  if (needed <= buffer.length) return;
  let size = buffer.length * 2;
  while (size < needed) size *= 2;
  const next = new Uint8Array(size);
  next.set(buffer.subarray(0, length));
  buffer = next;
}

function writeByte(byte: number): void {
  reserve(1);
  buffer[length++] = byte;
}

function writeAscii(value: string): void {
  reserve(value.length);
  for (let index = 0; index < value.length; index++) {
    buffer[length++] = value.charCodeAt(index);
  }
}

// Writes positive integers from 1 through 0x3fffff inclusive with the same
// bytewise order as their numeric value. Zero is reserved as a terminator;
// callers must keep values within the supported range and reserve 4 bytes.
function writePositiveInteger(value: number): void {
  if (value <= 0x7f) {
    buffer[length++] = value;
  } else if (value <= 0x7ff) {
    buffer[length++] = 0xc0 | (value >> 6);
    buffer[length++] = 0x80 | (value & 0x3f);
  } else if (value <= 0xffff) {
    buffer[length++] = 0xe0 | (value >> 12);
    buffer[length++] = 0x80 | ((value >> 6) & 0x3f);
    buffer[length++] = 0x80 | (value & 0x3f);
  } else {
    buffer[length++] = 0xf0 | (value >> 18);
    buffer[length++] = 0x80 | ((value >> 12) & 0x3f);
    buffer[length++] = 0x80 | ((value >> 6) & 0x3f);
    buffer[length++] = 0x80 | (value & 0x3f);
  }
}

function bytesOf(value: unknown): ArrayLike<number> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

function isBigintValue(value: unknown): boolean {
  return (
    typeof value === "bigint" ||
    (isEncodedObject(value) &&
      value.$hyperdbType === "bigint" &&
      typeof value.value === "string")
  );
}

function isBytesValue(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isEncodedBytesObject(value)
  );
}

function writeBigintPayload(value: unknown): void {
  const bigint = bigintOf(value);
  const negative = bigint < 0n;
  const digits = (negative ? -bigint : bigint).toString();
  if (digits.length > MAX_DECIMAL_LENGTH) {
    throw new Error("BigInt is too large to encode as a SQLite sort key");
  }

  if (!negative) {
    writeAscii(`1${digits.length.toString().padStart(15, "0")}`);
    writeAscii(digits);
    return;
  }

  const invertedLength = MAX_DECIMAL_LENGTH - digits.length;
  writeAscii(`0${invertedLength.toString().padStart(15, "0")}`);
  reserve(digits.length);
  for (let index = 0; index < digits.length; index++) {
    // "0".."9" is 0x30..0x39, so 9 - digit is 0x69 - code.
    buffer[length++] = 0x69 - digits.charCodeAt(index);
  }
}

function writeNumberPayload(value: number): void {
  numberView.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  reserve(8);
  if ((numberView.getUint8(0) & 0x80) !== 0) {
    for (let index = 0; index < 8; index++) {
      buffer[length++] = ~numberView.getUint8(index) & 0xff;
    }
  } else {
    buffer[length++] = numberView.getUint8(0) ^ 0x80;
    for (let index = 1; index < 8; index++) {
      buffer[length++] = numberView.getUint8(index);
    }
  }
}

function writeStringPayload(value: string): void {
  reserve(value.length * 4 + 1);
  for (let index = 0; index < value.length; index++) {
    writePositiveInteger(value.charCodeAt(index) + 1);
  }
  buffer[length++] = TERMINATOR;
}

function writeByteArrayPayload(bytes: ArrayLike<number>): void {
  reserve(bytes.length * 2 + 1);
  for (let index = 0; index < bytes.length; index++) {
    writePositiveInteger(bytes[index]! + 1);
  }
  buffer[length++] = TERMINATOR;
}

function writeArrayPayload(values: readonly unknown[]): void {
  for (let index = 0; index < values.length; index++) {
    // Holes in sparse arrays are skipped, as the format always has.
    if (index in values) writeStoredSortValue(values[index]);
  }
  writeByte(TERMINATOR);
}

function writeObjectPayload(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  writeArrayPayload(keys);
  for (const key of keys) {
    writeStoredSortValue(value[key]);
  }
  writeByte(TERMINATOR);
}

function writeScanSortValue(value: unknown): void {
  if (value === MIN) return writeByte(TAG.min);
  if (value === MAX) return writeByte(TAG.max);
  if (value === null || value === undefined) return writeByte(TAG.null);
  if (isBigintValue(value)) {
    writeByte(TAG.bigint);
    return writeBigintPayload(value);
  }
  if (typeof value === "number") {
    writeByte(TAG.number);
    return writeNumberPayload(value);
  }
  if (typeof value === "boolean") {
    writeByte(TAG.number);
    return writeNumberPayload(Number(value));
  }
  if (typeof value === "string") {
    writeByte(TAG.string);
    return writeStringPayload(value);
  }
  if (isBytesValue(value)) {
    writeByte(TAG.bytes);
    return writeByteArrayPayload(bytesOf(value));
  }

  throw new UnreachableError(value as never, "Unknown scan sort-key value");
}

function writeStoredSortValue(value: unknown): void {
  if (value === MIN) return writeByte(TAG.min);
  if (value === MAX) return writeByte(TAG.max);
  if (value === undefined) return writeByte(TAG.missing);
  if (value === null) return writeByte(TAG.null);

  if (isBigintValue(value)) {
    writeByte(TAG.bigint);
    return writeBigintPayload(value);
  }
  if (typeof value === "number") {
    writeByte(TAG.number);
    return writeNumberPayload(value);
  }
  if (typeof value === "boolean") {
    writeByte(TAG.boolean);
    return writeByte(value ? 1 : 0);
  }
  if (typeof value === "string") {
    writeByte(TAG.string);
    return writeStringPayload(value);
  }
  if (isBytesValue(value)) {
    writeByte(TAG.bytes);
    return writeByteArrayPayload(bytesOf(value));
  }
  if (Array.isArray(value)) {
    writeByte(TAG.array);
    return writeArrayPayload(value);
  }
  if (isEncodedObject(value)) {
    writeByte(TAG.object);
    return writeObjectPayload(value as Record<string, unknown>);
  }

  throw new UnreachableError(value as never, "Unknown stored sort-key value");
}

export function encodeSqliteSortKeyTuple(
  tuple: readonly unknown[],
  mode: SqliteSortKeyMode,
): Uint8Array {
  const writeValue =
    mode === "stored" ? writeStoredSortValue : writeScanSortValue;
  // A throw on an earlier call can leave bytes behind; start from empty.
  length = 0;
  for (let index = 0; index < tuple.length; index++) {
    if (index in tuple) writeValue(tuple[index]);
  }
  const key = buffer.slice(0, length);
  if (buffer.length > MAX_RETAINED_BUFFER_SIZE) {
    buffer = new Uint8Array(INITIAL_BUFFER_SIZE);
  }
  return key;
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
