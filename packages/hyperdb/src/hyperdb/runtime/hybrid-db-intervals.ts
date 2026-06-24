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
  supportsPartialLimitCoverage: boolean;
};

export type HybridIntervalCache = Map<string, NormalizedInterval[]>;

export const createHybridIntervalCache = (): HybridIntervalCache => new Map();

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
 * - full hash/equality lookups are cached, while partial limited coverage is
 *   only trusted for btree indexes or indexes whose first column is id;
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
  const intervals = convertWhereToBound(indexCols, clauses)
    .map((bound) => boundToInterval(bound, sortCols.length))
    .filter((interval) => !isEmptyInterval(interval));

  return {
    key: cacheKey(table, indexName),
    intervals: mergeIntervals(intervals),
    indexCols: sortCols,
    supportsPartialLimitCoverage:
      indexConfig.type === "btree" || indexCols[0] === "id",
  };
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
  primary: HyperDB,
  cache: HyperDB,
  cachedIntervals: HybridIntervalCache,
  selectEvent: SelectCommandEvent | undefined,
  table: TTable,
  indexName: keyof ExtractIndexes<TTable>,
  clauses: WhereClause[],
  selectOptions?: SelectOptions,
): Generator<DBCmd, ExtractSchema<TTable>[]> {
  if (selectOptions?.limit === 0) return [];

  const target = intervalFromClauses(table, indexName as string, clauses);
  const cached = cachedIntervals.get(target.key) ?? [];
  const uncovered = subtractIntervals(target.intervals, cached);

  if (uncovered.length === 0) {
    setSelectSource(selectEvent, "in-mem");
    return yield* cache.intervalScan(table, indexName, clauses, selectOptions);
  }

  if (selectOptions?.limit !== undefined) {
    setSelectSource(selectEvent, "in-mem");
    const cacheRows = yield* cache.intervalScan(
      table,
      indexName,
      clauses,
      selectOptions,
    );
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
  const primaryRows = yield* primary.intervalScan(
    table,
    indexName,
    clauses,
    selectOptions,
  );

  if (primaryRows.length > 0) {
    yield* cache.upsert(table, primaryRows);
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

  return primaryRows;
}
