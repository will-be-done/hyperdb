import type { SelectOptions, Value } from "../core/primitives";

export type HashIndexEntry<T> = {
  key: Value;
  id: string;
  value: T;
};

export type HashIndexOptions = {
  name: string;
  unique: boolean;
};

type HashKey = string;

function bytesOfHashValue(value: ArrayBuffer | ArrayBufferView): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  return Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
}

export function hashIndexKey(value: Value): HashKey {
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? 0 : value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  return `bytes:${bytesOfHashValue(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export interface HashIndexView<T> {
  readonly name: string;
  readonly unique: boolean;

  scan(keys: Iterable<Value>, options?: SelectOptions): T[];
  validateInsert(
    entries: readonly HashIndexEntry<T>[],
    replacingIds: ReadonlySet<string>,
  ): void;
  insert(entries: readonly HashIndexEntry<T>[]): void;
  upsert(entries: readonly HashIndexEntry<T>[]): void;
  delete(ids: readonly string[]): void;
}

function validateBatch<T>(
  index: HashIndexView<T>,
  entries: readonly HashIndexEntry<T>[],
  replacingIds: ReadonlySet<string>,
  bucket: (key: HashKey) => ReadonlyMap<string, T> | undefined,
): void {
  const keysById = new Map<string, HashKey>();
  const idsByKey = new Map<HashKey, string>();

  for (const entry of entries) {
    const key = hashIndexKey(entry.key);
    const previousKey = keysById.get(entry.id);
    if (previousKey !== undefined && previousKey !== key) {
      throw new Error(
        `Hash index ${index.name} received duplicate id ${entry.id}`,
      );
    }
    keysById.set(entry.id, key);

    if (!index.unique) continue;

    const batchId = idsByKey.get(key);
    if (batchId !== undefined && batchId !== entry.id) {
      throw new Error(
        `Unique hash index ${index.name} already has value for record ${batchId}`,
      );
    }
    idsByKey.set(key, entry.id);

    const existingValues = bucket(key);
    if (!existingValues) continue;
    for (const existingId of existingValues.keys()) {
      if (existingId === entry.id || replacingIds.has(existingId)) continue;
      throw new Error(
        `Unique hash index ${index.name} already has value for record ${existingId}`,
      );
    }
  }
}

function scanBuckets<T>(
  keys: Iterable<Value>,
  options: SelectOptions,
  bucket: (key: HashKey) => ReadonlyMap<string, T> | undefined,
): T[] {
  if (options.limit !== undefined && options.limit <= 0) return [];

  const results: T[] = [];
  const seenKeys = new Set<HashKey>();
  for (const value of keys) {
    const key = hashIndexKey(value);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const values = bucket(key);
    if (!values) continue;
    for (const item of values.values()) {
      results.push(item);
      if (options.limit !== undefined && results.length >= options.limit) {
        return results;
      }
    }
  }
  return results;
}

export class HashIndex<T> implements HashIndexView<T> {
  readonly name: string;
  readonly unique: boolean;
  readonly buckets = new Map<HashKey, Map<string, T>>();
  readonly keysById = new Map<string, HashKey>();

  constructor(options: HashIndexOptions) {
    this.name = options.name;
    this.unique = options.unique;
  }

  scan(keys: Iterable<Value>, options: SelectOptions = {}): T[] {
    return scanBuckets(keys, options, (key) => this.buckets.get(key));
  }

  values(): T[] {
    return Array.from(this.buckets.values()).flatMap((bucket) => [
      ...bucket.values(),
    ]);
  }

  validateInsert(
    entries: readonly HashIndexEntry<T>[],
    replacingIds: ReadonlySet<string>,
  ): void {
    validateBatch(this, entries, replacingIds, (key) => this.buckets.get(key));
  }

  insert(entries: readonly HashIndexEntry<T>[]): void {
    for (const entry of entries) {
      const key = hashIndexKey(entry.key);
      const bucket = this.buckets.get(key) ?? new Map<string, T>();
      bucket.set(entry.id, entry.value);
      this.buckets.set(key, bucket);
      this.keysById.set(entry.id, key);
    }
  }

  upsert(entries: readonly HashIndexEntry<T>[]): void {
    const replacingIds = new Set(entries.map((entry) => entry.id));
    this.validateInsert(entries, replacingIds);
    this.delete([...replacingIds]);
    this.insert(entries);
  }

  delete(ids: readonly string[]): void {
    for (const id of ids) {
      const key = this.keysById.get(id);
      if (key === undefined) continue;
      const bucket = this.buckets.get(key);
      bucket?.delete(id);
      if (bucket?.size === 0) this.buckets.delete(key);
      this.keysById.delete(id);
    }
  }

  tx(): HashIndexTx<T> {
    return new HashIndexTx(this);
  }
}

export class HashIndexTx<T> implements HashIndexView<T> {
  readonly name: string;
  readonly unique: boolean;
  private readonly original: HashIndex<T>;
  private readonly txBuckets = new Map<HashKey, Map<string, T>>();
  private readonly txKeysById = new Map<string, HashKey | undefined>();
  private finished = false;

  constructor(original: HashIndex<T>) {
    this.original = original;
    this.name = original.name;
    this.unique = original.unique;
  }

  scan(keys: Iterable<Value>, options: SelectOptions = {}): T[] {
    this.throwIfFinished("scan");
    return scanBuckets(keys, options, (key) => this.currentBucket(key));
  }

  validateInsert(
    entries: readonly HashIndexEntry<T>[],
    replacingIds: ReadonlySet<string>,
  ): void {
    this.throwIfFinished("validate inserts");
    validateBatch(this, entries, replacingIds, (key) =>
      this.currentBucket(key),
    );
  }

  insert(entries: readonly HashIndexEntry<T>[]): void {
    this.throwIfFinished("insert");
    for (const entry of entries) {
      const key = hashIndexKey(entry.key);
      const bucket = this.writableBucket(key);
      bucket.set(entry.id, entry.value);
      this.txKeysById.set(entry.id, key);
    }
  }

  upsert(entries: readonly HashIndexEntry<T>[]): void {
    const replacingIds = new Set(entries.map((entry) => entry.id));
    this.validateInsert(entries, replacingIds);
    this.delete([...replacingIds]);
    this.insert(entries);
  }

  delete(ids: readonly string[]): void {
    this.throwIfFinished("delete");
    for (const id of ids) {
      const key = this.txKeysById.has(id)
        ? this.txKeysById.get(id)
        : this.original.keysById.get(id);
      if (key === undefined) continue;
      this.writableBucket(key).delete(id);
      this.txKeysById.set(id, undefined);
    }
  }

  commit(): HashIndex<T> {
    this.throwIfFinished("commit");
    this.finished = true;
    for (const [key, bucket] of this.txBuckets) {
      if (bucket.size === 0) this.original.buckets.delete(key);
      else this.original.buckets.set(key, bucket);
    }
    for (const [id, key] of this.txKeysById) {
      if (key === undefined) this.original.keysById.delete(id);
      else this.original.keysById.set(id, key);
    }
    return this.original;
  }

  rollback(): HashIndex<T> {
    this.throwIfFinished("rollback");
    this.finished = true;
    return this.original;
  }

  private currentBucket(key: HashKey): ReadonlyMap<string, T> | undefined {
    return this.txBuckets.has(key)
      ? this.txBuckets.get(key)
      : this.original.buckets.get(key);
  }

  private writableBucket(key: HashKey): Map<string, T> {
    const existing = this.txBuckets.get(key);
    if (existing) return existing;

    const bucket = new Map(this.original.buckets.get(key));
    this.txBuckets.set(key, bucket);
    return bucket;
  }

  private throwIfFinished(operation: string): void {
    if (this.finished) {
      throw new Error(
        `Can't ${operation} after hash index transaction finished`,
      );
    }
  }
}
