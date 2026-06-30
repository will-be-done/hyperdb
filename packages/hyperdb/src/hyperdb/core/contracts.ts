import type { DBCmd } from "../commands/async";
import type { DBTransactionMode } from "./driver";
import type { CodecOptions } from "../storage/codec";
import type {
  ExtractIndexes,
  ExtractSchema,
  TableDefinition,
} from "../schema/table";
import type { SelectOptions, Trait, WhereClause } from "./primitives";
import type { HyperDBTracerOption } from "./tracer";

export type HybridPreloadTableSpec<
  TTable extends TableDefinition = TableDefinition,
> = {
  table: TTable;
  scanIndex: Extract<keyof ExtractIndexes<TTable>, string | number>;
  coverageIndexes?: readonly Extract<
    keyof ExtractIndexes<TTable>,
    string | number
  >[];
};

export type HybridPreloadTableSpecInput = {
  table: TableDefinition;
  scanIndex: string | number;
  coverageIndexes?: readonly (string | number)[];
};

export type ValidateHybridPreloadTableSpecs<
  TSpecs extends readonly HybridPreloadTableSpecInput[],
> = {
  readonly [K in keyof TSpecs]: TSpecs[K] extends { table: infer TTable }
    ? TTable extends TableDefinition
      ? HybridPreloadTableSpec<TTable>
      : never
    : never;
};

export interface HyperDB {
  intervalScan<
    TTable extends TableDefinition,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Generator<DBCmd, ExtractSchema<TTable>[]>;
  insert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void>;
  upsert<TTable extends TableDefinition>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Generator<DBCmd, void>;
  delete<TTable extends TableDefinition>(
    table: TTable,
    ids: string[],
  ): Generator<DBCmd, void>;
  withTraits(...trait: Trait[]): HyperDB;
  getTraits(): Trait[];
  getId(): string;
  getDBName?(): string | undefined;
  getTracer?(): HyperDBTracerOption | undefined;
  getOptions?(): CodecOptions;
  canUseReadonlyTransactionsForSelectors(): boolean;

  beginTx(mode?: DBTransactionMode): Generator<DBCmd, HyperDBTx>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadTables(tables: TableDefinition<any, any>[]): Generator<DBCmd, void>;
  preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void>;
}

export interface HyperDBTx extends HyperDB {
  commit(): Generator<DBCmd, void>;
  rollback(): Generator<DBCmd, void>;
}
