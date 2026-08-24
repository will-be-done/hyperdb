import { convertWhereToBound } from "../core/query/bounds";
import { compareStoredTuple, compareTuple } from "../core/query/tuple";
import type {
  Row,
  ScanValue,
  SelectOptions,
  Value,
  WhereClause,
} from "../core/primitives";
import type { TableDefinition } from "../schema/table";
import { InMemoryBinaryPlusTree } from "../structures/bptree";
import {
  HashIndex,
  HashIndexTx,
  hashIndexKey,
  type HashIndexEntry,
  type HashIndexView,
} from "../structures/hash-index";

type IndexDefinition = TableDefinition["indexes"][string];
type IndexEntry = { key: ScanValue[]; value: string };

const isSchemalessTable = (table: TableDefinition): boolean =>
  !table.schemaValidator;

function rowValue(row: Row, column: string): Value | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return undefined;
  const value = row[column];
  return value === undefined ? null : (value as Value);
}

function btreeKey(
  row: Row,
  columns: readonly string[],
  includeMissing: boolean,
): ScanValue[] | undefined {
  const values: ScanValue[] = [];
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      if (!includeMissing) return undefined;
      values.push(undefined as unknown as ScanValue);
      continue;
    }
    const value = row[column];
    values.push((value === undefined ? null : value) as ScanValue);
  }
  return values;
}

class IdHeap<T> {
  private values: T[] = [];
  private readonly compare: (left: T, right: T) => number;

  constructor(compare: (left: T, right: T) => number) {
    this.compare = compare;
  }

  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.values[index]!, this.values[parent]!) >= 0) break;
      [this.values[index], this.values[parent]] = [
        this.values[parent]!,
        this.values[index]!,
      ];
      index = parent;
    }
  }

  pop(): T | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (last === undefined || this.values.length === 0) return first;
    this.values[0] = last;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < this.values.length &&
        this.compare(this.values[left]!, this.values[smallest]!) < 0
      ) {
        smallest = left;
      }
      if (
        right < this.values.length &&
        this.compare(this.values[right]!, this.values[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.values[index], this.values[smallest]] = [
        this.values[smallest]!,
        this.values[index]!,
      ];
      index = smallest;
    }
    return first;
  }

  get size(): number {
    return this.values.length;
  }
}

interface IdOnlyIndex {
  scan(clauses: WhereClause[], options: SelectOptions): string[];
  validateUpsert(rows: Row[]): void;
  upsert(rows: Row[]): void;
  delete(ids: string[]): void;
  fork(): IdOnlyIndex;
  materializeFork(): void;
  discardFork(): void;
}

class IdBtreeIndex implements IdOnlyIndex {
  private tree: InMemoryBinaryPlusTree<ScanValue[], string>;
  private readonly keysById: Map<string, ScanValue[]>;
  private readonly logicalColumns: string[];
  private readonly storedColumns: string[];
  private readonly includeMissing: boolean;
  private readonly compareKey: (
    left: ScanValue[],
    right: ScanValue[],
  ) => number;

  constructor(
    definition: IndexDefinition,
    includeMissing: boolean,
    tree?: InMemoryBinaryPlusTree<ScanValue[], string>,
    keysById?: Map<string, ScanValue[]>,
  ) {
    this.logicalColumns = definition.cols.map(String);
    this.storedColumns = [...this.logicalColumns];
    if (this.storedColumns[this.storedColumns.length - 1] !== "id") {
      this.storedColumns.push("id");
    }
    this.includeMissing = includeMissing;
    this.compareKey = this.includeMissing
      ? (compareStoredTuple as (
          left: ScanValue[],
          right: ScanValue[],
        ) => number)
      : compareTuple;
    this.tree =
      tree ??
      new InMemoryBinaryPlusTree<ScanValue[], string>(64, 128, this.compareKey);
    this.keysById = keysById ?? new Map();
  }

  scan(clauses: WhereClause[], options: SelectOptions): string[] {
    if (options.limit !== undefined && options.limit <= 0) return [];
    const bounds = convertWhereToBound(this.storedColumns, clauses);
    const iterators = bounds.map((bound) =>
      this.tree.iterate({
        ...bound,
        reverse: options.order === "desc",
      }),
    );
    type Cursor = {
      iterator: IterableIterator<IndexEntry>;
      current: IndexEntry;
      sequence: number;
    };
    const reverse = options.order === "desc";
    const heap = new IdHeap<Cursor>((left, right) => {
      const compared = this.compareKey(left.current.key, right.current.key);
      if (compared !== 0) return reverse ? -compared : compared;
      return left.sequence - right.sequence;
    });

    iterators.forEach((iterator, sequence) => {
      const next = iterator.next();
      if (!next.done) heap.push({ iterator, current: next.value, sequence });
    });

    const result: string[] = [];
    const seen = new Set<string>();
    while (heap.size > 0) {
      const cursor = heap.pop()!;
      if (!seen.has(cursor.current.value)) {
        seen.add(cursor.current.value);
        result.push(cursor.current.value);
        if (options.limit !== undefined && result.length >= options.limit) {
          return result;
        }
      }
      const next = cursor.iterator.next();
      if (!next.done) {
        cursor.current = next.value;
        heap.push(cursor);
      }
    }
    return result;
  }

  upsert(rows: Row[]): void {
    for (const row of rows) {
      const oldKey = this.keysById.get(row.id);
      if (oldKey) this.tree.delete(oldKey);

      const key = btreeKey(row, this.storedColumns, this.includeMissing);
      if (!key) {
        this.keysById.delete(row.id);
        continue;
      }
      this.keysById.set(row.id, key);
      this.tree.set(key, row.id);
    }
  }

  validateUpsert(_rows: Row[]): void {}

  delete(ids: string[]): void {
    for (const id of ids) {
      const key = this.keysById.get(id);
      if (key) this.tree.delete(key);
      this.keysById.delete(id);
    }
  }

  fork(): IdOnlyIndex {
    return new IdBtreeIndex(
      { type: "btree", cols: this.logicalColumns },
      this.includeMissing,
      this.tree.fork(),
      new Map(this.keysById),
    );
  }

  materializeFork(): void {
    this.tree = this.tree.materializeFork();
  }

  discardFork(): void {
    this.tree.discardFork();
  }
}

class IdHashIndex implements IdOnlyIndex {
  private readonly name: string;
  private readonly column: string;
  private readonly unique: boolean;
  private index: HashIndex<string> | HashIndexTx<string>;

  constructor(
    name: string,
    definition: IndexDefinition,
    index?: HashIndex<string> | HashIndexTx<string>,
  ) {
    this.name = name;
    this.column = String(definition.cols[0]);
    this.unique = definition.type === "uniqhash";
    this.index = index ?? new HashIndex<string>({ name, unique: this.unique });
  }

  scan(clauses: WhereClause[], options: SelectOptions): string[] {
    return scanHashIndex(this.index, this.column, clauses, options);
  }

  private entries(rows: readonly Row[]): HashIndexEntry<string>[] {
    return rows.flatMap((row) => {
      const value = rowValue(row, this.column);
      return value === undefined
        ? []
        : [{ key: value, id: row.id, value: row.id }];
    });
  }

  validateUpsert(rows: Row[]): void {
    const entries = this.entries(rows);
    this.index.validateInsert(entries, new Set(rows.map((row) => row.id)));
  }

  upsert(rows: Row[]): void {
    this.index.delete(rows.map((row) => row.id));
    this.index.insert(this.entries(rows));
  }

  delete(ids: string[]): void {
    this.index.delete(ids);
  }

  fork(): IdOnlyIndex {
    if (!(this.index instanceof HashIndex)) {
      throw new Error(`Cannot fork hash index transaction ${this.name}`);
    }
    return new IdHashIndex(
      this.name,
      {
        type: this.unique ? "uniqhash" : "hash",
        cols: [this.column],
      },
      this.index.tx(),
    );
  }

  materializeFork(): void {
    if (this.index instanceof HashIndexTx) this.index = this.index.commit();
  }

  discardFork(): void {
    if (this.index instanceof HashIndexTx) this.index = this.index.rollback();
  }
}

export function hashScanValues(
  column: string,
  clauses: WhereClause[],
): Value[] {
  const bounds = convertWhereToBound([column], clauses);
  const values: Value[] = [];

  for (const bound of bounds) {
    if (
      bound.gt ||
      bound.lt ||
      !bound.gte ||
      !bound.lte ||
      bound.gte.length !== 1 ||
      bound.lte.length !== 1 ||
      typeof bound.gte[0] === "symbol" ||
      typeof bound.lte[0] === "symbol" ||
      hashIndexKey(bound.gte[0]) !== hashIndexKey(bound.lte[0])
    ) {
      throw new Error(
        `Hash index should have exactly one equality condition for column '${column}'`,
      );
    }
    values.push(bound.gte[0]);
  }

  return values;
}

export function scanHashIndex<T>(
  index: HashIndexView<T>,
  column: string,
  clauses: WhereClause[],
  options: SelectOptions = {},
): T[] {
  return index.scan(hashScanValues(column, clauses), options);
}

export class PreloadedTableIndexes {
  private readonly indexes = new Map<string, IdOnlyIndex>();
  readonly table: TableDefinition;

  private static empty(table: TableDefinition): PreloadedTableIndexes {
    return new PreloadedTableIndexes(table, [], false);
  }

  constructor(
    table: TableDefinition,
    rows: Row[] = [],
    initializeIndexes = true,
  ) {
    this.table = table;
    if (!initializeIndexes) return;

    for (const [indexName, definition] of Object.entries(table.indexes)) {
      if (indexName === table.idIndexName) continue;
      this.indexes.set(
        indexName,
        definition.type === "btree"
          ? new IdBtreeIndex(definition, isSchemalessTable(table))
          : new IdHashIndex(indexName, definition),
      );
    }
    this.upsert(rows);
  }

  scan(
    indexName: string,
    clauses: WhereClause[],
    options: SelectOptions = {},
  ): string[] {
    if (clauses.length === 0) throw new Error("scan clauses must be provided");
    const index = this.indexes.get(indexName);
    if (!index) {
      throw new Error(
        `Index not found: ${indexName} for table: ${this.table.tableName}`,
      );
    }
    return index.scan(clauses, options);
  }

  upsert(rows: Row[]): void {
    for (const index of this.indexes.values()) index.validateUpsert(rows);
    for (const index of this.indexes.values()) index.upsert(rows);
  }

  delete(ids: string[]): void {
    for (const index of this.indexes.values()) index.delete(ids);
  }

  fork(): PreloadedTableIndexes {
    const fork = PreloadedTableIndexes.empty(this.table);
    for (const [name, index] of this.indexes) {
      fork.indexes.set(name, index.fork());
    }
    return fork;
  }

  materializeFork(): void {
    for (const index of this.indexes.values()) index.materializeFork();
  }

  discardFork(): void {
    for (const index of this.indexes.values()) index.discardFork();
  }
}
