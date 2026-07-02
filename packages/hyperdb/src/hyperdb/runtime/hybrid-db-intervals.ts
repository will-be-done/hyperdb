import type { DBCmd } from "../commands/async";
import { convertWhereToBound } from "../core/query/bounds";
import { compareTuple, normalizeTupleBounds } from "../core/query/tuple";
import type { HyperDB } from "../core/contracts";
import {
  MAX,
  MIN,
  type Row,
  type SelectOptions,
  type Tuple,
  type TupleScanOptions,
  type Value,
  type WhereClause,
} from "../core/primitives";
import type { SelectCommandEvent, SelectScanSource } from "../core/tracer";
import type {
  ExtractIndexes,
  ExtractSchema,
  TableDefinition,
} from "../schema/table";

export type NormalizedInterval = {
  lower: Tuple;
  lowerInclusive: boolean;
  upper: Tuple;
  upperInclusive: boolean;
};

export type IntervalTarget = {
  key: string;
  intervals: NormalizedInterval[];
  indexCols: string[];
  exactUniqhashKeys: { key: string; interval: NormalizedInterval }[];
  supportsPartialLimitCoverage: boolean;
};

export class HybridIntervalCache extends Map<string, NormalizedInterval[]> {
  exactKeys = new Map<string, Set<string>>();

  override clear(): void {
    super.clear();
    this.exactKeys.clear();
  }
}

export const createHybridIntervalCache = (): HybridIntervalCache =>
  new HybridIntervalCache();

export type HybridPersistentScanDebugInfo = {
  target: IntervalTarget;
  cached: NormalizedInterval[];
  uncovered: NormalizedInterval[];
  limitedCacheProbe?: {
    rowCount: number;
    limit: number;
    order: SelectOptions["order"];
  };
};

/*
 * HybridDB cache coverage is tracked per table index as normalized tuple
 * intervals. The current cache plan is intentionally conservative:
 *
 * - fully covered scans are served from the in-memory cache;
 * - sub-ranges of previously loaded ranges are covered;
 * - overlapping and touching coverage is merged;
 * - disjoint multi-clause scans use cache when every target interval is covered;
 * - unlimited empty misses still mark the requested range as covered;
 * - limited btree scans cache the proven prefix or suffix up to the last
 *   returned row, including duplicate index values via an appended id column;
 * - full hash/equality lookups are cached when the scan itself proves the
 *   bucket;
 * - unique hash values loaded through any persistent scan are marked covered
 *   exactly, because at most one row can match each value;
 * - partial limited coverage is only trusted for btree, uniqhash, or legacy
 *   id-first indexes;
 * - transaction coverage is merged into the parent DB only on commit;
 * - loadTables clears coverage because table contents may have changed.
 *
 * Not supported yet: mixed cache/persistent plans. If an unlimited query is
 * only partially covered, HybridDB currently scans the whole query from the
 * primary store instead of fetching only uncovered intervals and merging them
 * with cached rows.
 */

const cacheKey = (table: TableDefinition, indexName: string) =>
  `${table.tableName}:${indexName}`;

const minTuple = (count: number): Tuple =>
  Array.from({ length: count }, () => MIN);

const maxTuple = (count: number): Tuple =>
  Array.from({ length: count }, () => MAX);

const rowToTuple = (row: Row, indexCols: string[]): Tuple =>
  indexCols.map((col) => row[col] as Value);

const rowToIndexValue = (row: Row, col: string): Value | undefined => {
  if (!Object.prototype.hasOwnProperty.call(row, col)) return undefined;

  const value = row[col];
  return value === undefined ? null : (value as Value);
};

function bytesOfExactValue(value: ArrayBuffer | ArrayBufferView): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  return Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

const exactValueKey = (value: Value): string => {
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? 0 : value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  return `bytes:${bytesOfExactValue(value).map(toHex).join("")}`;
};

const tupleInInterval = (
  tuple: Tuple,
  interval: NormalizedInterval,
): boolean => {
  const lowerCmp = compareTuple(tuple, interval.lower);
  if (lowerCmp < 0 || (lowerCmp === 0 && !interval.lowerInclusive)) {
    return false;
  }

  const upperCmp = compareTuple(tuple, interval.upper);
  if (upperCmp > 0 || (upperCmp === 0 && !interval.upperInclusive)) {
    return false;
  }

  return true;
};

export const boundToInterval = (
  bound: TupleScanOptions,
  tupleCount: number,
): NormalizedInterval => {
  const normalized = normalizeTupleBounds(bound, tupleCount);
  return {
    lower: normalized.gte ?? normalized.gt ?? minTuple(tupleCount),
    lowerInclusive: normalized.gte !== undefined || normalized.gt === undefined,
    upper: normalized.lte ?? normalized.lt ?? maxTuple(tupleCount),
    upperInclusive: normalized.lte !== undefined || normalized.lt === undefined,
  };
};

export const intervalFromClauses = (
  table: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
): IntervalTarget => {
  if (clauses.length === 0) {
    throw new Error("scan clauses must be provided");
  }

  const indexConfig = table.indexes[indexName];
  if (!indexConfig) {
    throw new Error(
      `Index not found: ${indexName} for table: ${table.tableName}`,
    );
  }

  const indexCols = indexConfig.cols as string[];
  const sortCols =
    indexConfig.type === "btree" && indexCols[indexCols.length - 1] !== "id"
      ? [...indexCols, "id"]
      : indexCols;
  const bounds = convertWhereToBound(indexCols, clauses);
  const intervals = bounds
    .map((bound) => boundToInterval(bound, sortCols.length))
    .filter((interval) => !isEmptyInterval(interval));
  const exactUniqhashKeys =
    indexConfig.type === "uniqhash" && indexCols.length === 1
      ? bounds.flatMap((bound) => {
          if (
            bound.gt !== undefined ||
            bound.lt !== undefined ||
            !bound.gte ||
            !bound.lte ||
            bound.gte.length !== 1 ||
            bound.lte.length !== 1
          ) {
            return [];
          }

          const gteKey = exactValueKey(bound.gte[0] as Value);
          if (gteKey !== exactValueKey(bound.lte[0] as Value)) return [];

          const interval = boundToInterval(bound, 1);
          return isEmptyInterval(interval) ? [] : [{ key: gteKey, interval }];
        })
      : [];

  return {
    key: cacheKey(table, indexName),
    intervals: mergeIntervals(intervals),
    indexCols: sortCols,
    exactUniqhashKeys,
    supportsPartialLimitCoverage:
      indexConfig.type === "btree" ||
      indexConfig.type === "uniqhash" ||
      indexCols[0] === "id",
  };
};

export const rowMatchesIntervalTarget = (
  row: Row,
  target: IntervalTarget,
): boolean => {
  const tuple = rowToTuple(row, target.indexCols);
  return target.intervals.some((interval) => tupleInInterval(tuple, interval));
};

export const isEmptyInterval = (interval: NormalizedInterval) => {
  const cmp = compareTuple(interval.lower, interval.upper);
  return (
    cmp > 0 ||
    (cmp === 0 && (!interval.lowerInclusive || !interval.upperInclusive))
  );
};

const compareLower = (a: NormalizedInterval, b: NormalizedInterval) => {
  const cmp = compareTuple(a.lower, b.lower);
  if (cmp !== 0) return cmp;
  if (a.lowerInclusive === b.lowerInclusive) return 0;
  return a.lowerInclusive ? -1 : 1;
};

const compareUpper = (a: NormalizedInterval, b: NormalizedInterval) => {
  const cmp = compareTuple(a.upper, b.upper);
  if (cmp !== 0) return cmp;
  if (a.upperInclusive === b.upperInclusive) return 0;
  return a.upperInclusive ? 1 : -1;
};

const canMerge = (a: NormalizedInterval, b: NormalizedInterval) => {
  const cmp = compareTuple(a.upper, b.lower);
  return cmp > 0 || (cmp === 0 && (a.upperInclusive || b.lowerInclusive));
};

const mergeTwo = (
  a: NormalizedInterval,
  b: NormalizedInterval,
): NormalizedInterval => {
  const upperCmp = compareUpper(a, b);
  return {
    lower: a.lower,
    lowerInclusive: a.lowerInclusive,
    upper: upperCmp >= 0 ? a.upper : b.upper,
    upperInclusive: upperCmp >= 0 ? a.upperInclusive : b.upperInclusive,
  };
};

export const mergeIntervals = (
  intervals: NormalizedInterval[],
): NormalizedInterval[] => {
  const sorted = [...intervals].sort(compareLower);
  const merged: NormalizedInterval[] = [];

  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || !canMerge(last, interval)) {
      merged.push(interval);
    } else {
      merged[merged.length - 1] = mergeTwo(last, interval);
    }
  }

  return merged;
};

export const hasOverlap = (a: NormalizedInterval, b: NormalizedInterval) => {
  const leftCmp = compareTuple(a.upper, b.lower);
  if (
    leftCmp < 0 ||
    (leftCmp === 0 && (!a.upperInclusive || !b.lowerInclusive))
  ) {
    return false;
  }

  const rightCmp = compareTuple(b.upper, a.lower);
  if (
    rightCmp < 0 ||
    (rightCmp === 0 && (!b.upperInclusive || !a.lowerInclusive))
  ) {
    return false;
  }

  return true;
};

export const subtractOne = (
  target: NormalizedInterval,
  cover: NormalizedInterval,
): NormalizedInterval[] => {
  if (!hasOverlap(target, cover)) return [target];

  const result: NormalizedInterval[] = [];
  const lowerCmp = compareTuple(target.lower, cover.lower);
  if (
    lowerCmp < 0 ||
    (lowerCmp === 0 && target.lowerInclusive && !cover.lowerInclusive)
  ) {
    result.push({
      lower: target.lower,
      lowerInclusive: target.lowerInclusive,
      upper: cover.lower,
      upperInclusive: !cover.lowerInclusive,
    });
  }

  const upperCmp = compareTuple(cover.upper, target.upper);
  if (
    upperCmp < 0 ||
    (upperCmp === 0 && !cover.upperInclusive && target.upperInclusive)
  ) {
    result.push({
      lower: cover.upper,
      lowerInclusive: !cover.upperInclusive,
      upper: target.upper,
      upperInclusive: target.upperInclusive,
    });
  }

  return result.filter((interval) => !isEmptyInterval(interval));
};

export const subtractIntervals = (
  targets: NormalizedInterval[],
  covers: NormalizedInterval[],
) => {
  let remaining = targets;
  for (const cover of covers) {
    remaining = remaining.flatMap((target) => subtractOne(target, cover));
  }
  return mergeIntervals(remaining);
};

export const intervalsForLimitedRows = (
  queryIntervals: NormalizedInterval[],
  rows: Row[],
  indexCols: string[],
  order: SelectOptions["order"],
) => {
  if (rows.length === 0) return [];

  const lastTuple = rowToTuple(rows[rows.length - 1], indexCols);

  if (order === "desc") {
    const intervals = [...queryIntervals].sort((a, b) => -compareUpper(a, b));
    const covered: NormalizedInterval[] = [];
    for (const interval of intervals) {
      if (compareTuple(interval.upper, lastTuple) < 0) break;

      if (compareTuple(interval.lower, lastTuple) >= 0) {
        covered.push(interval);
      } else {
        covered.push({
          lower: lastTuple,
          lowerInclusive: true,
          upper: interval.upper,
          upperInclusive: interval.upperInclusive,
        });
        break;
      }
    }
    return mergeIntervals(covered);
  }

  const intervals = [...queryIntervals].sort(compareLower);
  const covered: NormalizedInterval[] = [];
  for (const interval of intervals) {
    if (compareTuple(interval.lower, lastTuple) > 0) break;

    if (compareTuple(interval.upper, lastTuple) <= 0) {
      covered.push(interval);
    } else {
      covered.push({
        lower: interval.lower,
        lowerInclusive: interval.lowerInclusive,
        upper: lastTuple,
        upperInclusive: true,
      });
      break;
    }
  }
  return mergeIntervals(covered);
};

export const mergeCoverage = (
  cachedIntervals: HybridIntervalCache,
  key: string,
  intervals: NormalizedInterval[],
) => {
  if (intervals.length === 0) return;
  cachedIntervals.set(
    key,
    mergeIntervals([...(cachedIntervals.get(key) ?? []), ...intervals]),
  );
};

export const mergeCoverageMaps = (
  parent: HybridIntervalCache,
  child: HybridIntervalCache,
) => {
  for (const [key, intervals] of child) {
    mergeCoverage(parent, key, intervals);
  }
  for (const [key, exactKeys] of child.exactKeys) {
    let parentKeys = parent.exactKeys.get(key);
    if (!parentKeys) {
      parentKeys = new Set();
      parent.exactKeys.set(key, parentKeys);
    }
    for (const exactKey of exactKeys) {
      parentKeys.add(exactKey);
    }
  }
};

export const mergeExactUniqhashCoverage = (
  cachedIntervals: HybridIntervalCache,
  key: string,
  value: Value,
) => {
  let exactKeys = cachedIntervals.exactKeys.get(key);
  if (!exactKeys) {
    exactKeys = new Set();
    cachedIntervals.exactKeys.set(key, exactKeys);
  }
  exactKeys.add(exactValueKey(value));
};

export const mergeExactUniqhashCoverageForRows = (
  cachedIntervals: HybridIntervalCache,
  table: TableDefinition,
  rows: Row[],
) => {
  if (rows.length === 0) return;

  for (const [indexName, indexConfig] of Object.entries(table.indexes)) {
    if (indexConfig.type !== "uniqhash" || indexConfig.cols.length !== 1) {
      continue;
    }

    const col = String(indexConfig.cols[0]);
    for (const row of rows) {
      const value = rowToIndexValue(row, col);
      if (value === undefined) continue;

      mergeExactUniqhashCoverage(
        cachedIntervals,
        cacheKey(table, indexName),
        value,
      );
    }
  }
};

export const canServeLimitedResultFromCache = (
  cacheRows: Row[],
  limit: number | undefined,
  uncovered: NormalizedInterval[],
  indexCols: string[],
  order: SelectOptions["order"],
) => {
  if (
    limit === undefined ||
    cacheRows.length < limit ||
    uncovered.length === 0
  ) {
    return false;
  }

  const lastTuple = rowToTuple(cacheRows[cacheRows.length - 1], indexCols);
  if (order === "desc") {
    const firstGap = [...uncovered].sort((a, b) => -compareUpper(a, b))[0];
    const cmp = compareTuple(lastTuple, firstGap.upper);
    return cmp > 0 || (cmp === 0 && !firstGap.upperInclusive);
  }

  const firstGap = [...uncovered].sort(compareLower)[0];
  const cmp = compareTuple(lastTuple, firstGap.lower);
  return cmp < 0 || (cmp === 0 && !firstGap.lowerInclusive);
};

const setSelectSource = (
  event: SelectCommandEvent | undefined,
  source: SelectScanSource,
): void => {
  if (event) {
    event.source = source;
  }
};

export function* hybridIntervalScan<TTable extends TableDefinition>(
  primary: HyperDB | (() => Generator<DBCmd, HyperDB>),
  cache: HyperDB,
  cachedIntervals: HybridIntervalCache,
  selectEvent: SelectCommandEvent | undefined,
  table: TTable,
  indexName: keyof ExtractIndexes<TTable>,
  clauses: WhereClause[],
  selectOptions?: SelectOptions,
  options: {
    additionalCachedIntervals?: HybridIntervalCache[];
    beforePersistentScan?: (target: IntervalTarget) => Generator<DBCmd, void>;
    filterPersistentRows?: (
      target: IntervalTarget,
      rows: ExtractSchema<TTable>[],
    ) => ExtractSchema<TTable>[];
    onPersistentScan?: (info: HybridPersistentScanDebugInfo) => void;
    returnCacheAfterPersistentScan?: (target: IntervalTarget) => boolean;
  } = {},
): Generator<DBCmd, ExtractSchema<TTable>[]> {
  if (selectOptions?.limit === 0) return [];

  const target = intervalFromClauses(table, indexName as string, clauses);
  const exactCovered = target.exactUniqhashKeys.flatMap((exact) => {
    const isCovered = [
      cachedIntervals,
      ...(options.additionalCachedIntervals ?? []),
    ].some((intervals) => intervals.exactKeys.get(target.key)?.has(exact.key));

    return isCovered ? [exact.interval] : [];
  });
  const cached = mergeIntervals([
    ...(cachedIntervals.get(target.key) ?? []),
    ...(options.additionalCachedIntervals ?? []).flatMap(
      (intervals) => intervals.get(target.key) ?? [],
    ),
    ...exactCovered,
  ]);
  const uncovered = subtractIntervals(target.intervals, cached);

  if (uncovered.length === 0) {
    setSelectSource(selectEvent, "in-mem");
    return yield* cache.intervalScan(table, indexName, clauses, selectOptions);
  }

  let limitedCacheProbe: HybridPersistentScanDebugInfo["limitedCacheProbe"];
  if (selectOptions?.limit !== undefined) {
    setSelectSource(selectEvent, "in-mem");
    const cacheRows = yield* cache.intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );
    limitedCacheProbe = {
      rowCount: cacheRows.length,
      limit: selectOptions.limit,
      order: selectOptions.order,
    };
    if (
      canServeLimitedResultFromCache(
        cacheRows as Row[],
        selectOptions.limit,
        uncovered,
        target.indexCols,
        selectOptions.order,
      )
    ) {
      return cacheRows;
    }
  }

  setSelectSource(selectEvent, "persist");
  options.onPersistentScan?.({
    target,
    cached,
    uncovered,
    limitedCacheProbe,
  });
  if (options.beforePersistentScan) {
    yield* options.beforePersistentScan(target);
  }
  const primaryDB = typeof primary === "function" ? yield* primary() : primary;
  const persistentRows = yield* primaryDB.intervalScan(
    table,
    indexName,
    clauses,
    selectOptions,
  );
  const primaryRows =
    options.filterPersistentRows?.(target, persistentRows) ?? persistentRows;

  if (primaryRows.length > 0) {
    yield* cache.upsert(table, primaryRows);
    mergeExactUniqhashCoverageForRows(
      cachedIntervals,
      table,
      primaryRows as Row[],
    );
  }

  const fullyLoaded =
    selectOptions?.limit === undefined ||
    primaryRows.length < selectOptions.limit;
  const loadedIntervals = fullyLoaded
    ? target.intervals
    : target.supportsPartialLimitCoverage
      ? intervalsForLimitedRows(
          target.intervals,
          primaryRows as Row[],
          target.indexCols,
          selectOptions.order,
        )
      : [];
  mergeCoverage(cachedIntervals, target.key, loadedIntervals);

  if (options.returnCacheAfterPersistentScan?.(target)) {
    return yield* cache.intervalScan(table, indexName, clauses, selectOptions);
  }

  return primaryRows;
}
