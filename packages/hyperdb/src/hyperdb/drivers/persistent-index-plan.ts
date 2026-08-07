import type { TableDefinition } from "../schema/table";

export type PersistentSortKeyMode = "scan" | "stored";

export type PersistentPhysicalIndex = {
  readonly name: string;
  readonly sortColumns: readonly string[];
  readonly unique: boolean;
  readonly mode: PersistentSortKeyMode;
};

export type PersistentIndexPlan = {
  readonly physicalIndexes: readonly PersistentPhysicalIndex[];
  readonly byLogicalName: ReadonlyMap<string, PersistentPhysicalIndex>;
};

const persistentIndexPlanCache = new WeakMap<
  TableDefinition,
  PersistentIndexPlan
>();

export function isPrimaryKeyBackedIndex(
  tableDef: TableDefinition,
  indexName: string,
): boolean {
  const indexDef = tableDef.indexes[indexName];
  return (
    indexDef !== undefined &&
    (indexDef.type === "hash" || indexDef.type === "uniqhash") &&
    indexDef.cols.length === 1 &&
    String(indexDef.cols[0]) === "id"
  );
}

export function getPersistentIndexSortKeyMode(
  tableDef: TableDefinition,
  indexName: string,
): PersistentSortKeyMode {
  const indexDef = tableDef.indexes[indexName];
  return indexDef?.type === "btree" && !tableDef.schemaValidator
    ? "stored"
    : "scan";
}

export function getPersistentIndexPlan(
  tableDef: TableDefinition,
): PersistentIndexPlan {
  const cached = persistentIndexPlanCache.get(tableDef);
  if (cached) return cached;

  // Persistent drivers can use the native primary key directly, and a unique
  // ordered index can serve compatible uniqhash and B-tree declarations.
  const logicalNames = Object.keys(tableDef.indexes)
    .filter((indexName) => !isPrimaryKeyBackedIndex(tableDef, indexName))
    .sort();
  const consumed = new Set<string>();
  const physicalIndexes: PersistentPhysicalIndex[] = [];
  const byLogicalName = new Map<string, PersistentPhysicalIndex>();

  for (const logicalName of logicalNames) {
    if (consumed.has(logicalName)) continue;
    const indexDef = tableDef.indexes[logicalName]!;
    const columns = indexDef.cols.map(String);
    const mode = getPersistentIndexSortKeyMode(tableDef, logicalName);
    const aliases = [logicalName];

    if (indexDef.type === "btree" || indexDef.type === "uniqhash") {
      for (const candidateName of logicalNames) {
        if (candidateName === logicalName || consumed.has(candidateName)) {
          continue;
        }
        const candidate = tableDef.indexes[candidateName]!;
        const candidateColumns = candidate.cols.map(String);
        const isUniqueOrderedPair =
          new Set([indexDef.type, candidate.type]).size === 2 &&
          (indexDef.type === "uniqhash" || candidate.type === "uniqhash") &&
          (indexDef.type === "btree" || candidate.type === "btree");
        const sameColumns =
          columns.length === candidateColumns.length &&
          columns.every((column, index) => column === candidateColumns[index]);

        if (
          isUniqueOrderedPair &&
          sameColumns &&
          mode === getPersistentIndexSortKeyMode(tableDef, candidateName)
        ) {
          aliases.push(candidateName);
        }
      }
    }

    aliases.sort();
    for (const alias of aliases) consumed.add(alias);
    const unique = aliases.some(
      (alias) => tableDef.indexes[alias]?.type === "uniqhash",
    );
    const sortColumns = [...columns];
    if (!unique && sortColumns[sortColumns.length - 1] !== "id") {
      sortColumns.push("id");
    }

    const physicalIndex: PersistentPhysicalIndex = {
      name: aliases[0]!,
      sortColumns,
      unique,
      mode,
    };
    physicalIndexes.push(physicalIndex);
    for (const alias of aliases) byLogicalName.set(alias, physicalIndex);
  }

  const plan = { physicalIndexes, byLogicalName };
  persistentIndexPlanCache.set(tableDef, plan);
  return plan;
}
