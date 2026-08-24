/* eslint-disable @typescript-eslint/no-explicit-any */
import { convertWhereToBound } from "../core/query/bounds";
import type { DBCmd } from "../commands/async";
import type {
  HyperDB,
  HybridPreloadTableSpecInput,
  ValidateHybridPreloadTableSpecs,
} from "../core/contracts";
import type {
  BaseDBDriverOperations,
  DBDriver,
  DBDriverOperationOptions,
  DBTransactionMode,
} from "../core/driver";
import type {
  Row,
  SelectOptions,
  Trait,
  WhereClause,
} from "../core/primitives";
import {
  getDriverTraceContextForDB,
  type HyperDBTracerOption,
} from "../core/tracer";
import { deepFreeze } from "../deep-freeze";
import {
  DEFAULT_CODEC_OPTIONS,
  normalizeRecordsForDriver,
  validateRecordsFromDriver,
  type CodecOptions,
} from "../storage/codec";
import type {
  ExtractIndexes,
  ExtractSchema,
  TableDefinition,
} from "../schema/table";
import { registerHyperDB } from "../tracing/registry";
import { DBTx } from "./db-tx";

export type DBOptions = Partial<CodecOptions> & {
  dbName?: string;
  register?: boolean;
  traits?: Trait[];
  tracer?: HyperDBTracerOption;
};

type DBState = {
  tables: TableDefinition<any, any>[];
  options: CodecOptions;
  id: string;
  name?: string;
  tracer?: HyperDBTracerOption;
};

let dbIdCounter = 0;

const createDBId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  dbIdCounter += 1;
  return `db-${Date.now().toString(36)}-${dbIdCounter.toString(36)}`;
};

const createDBState = (options: DBOptions): DBState => {
  return {
    tables: [],
    options: {
      ...DEFAULT_CODEC_OPTIONS,
      runtimeRowsValidation: options.runtimeRowsValidation ?? false,
      freezeArgs: options.freezeArgs ?? false,
      freezeRows: options.freezeRows ?? false,
    },
    id: createDBId(),
    name: options.dbName,
    tracer: options.tracer,
  };
};

function* performScan(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  indexName: string,
  clauses: WhereClause[],
  options: CodecOptions,
  selectOptions?: SelectOptions,
  driverOptions?: DBDriverOperationOptions,
) {
  if (clauses.length === 0) {
    throw new Error("scan clauses must be provided");
  }
  if (selectOptions && selectOptions.limit === 0) {
    return [];
  }

  const indexConfig = table.indexes[indexName as string];
  if (!indexConfig) {
    throw new Error(
      `Index not found: ${indexName as string} for table: ${table.tableName}`,
    );
  }

  // Validation-only; driver handles conversion.
  convertWhereToBound(indexConfig.cols as string[], clauses);

  const records = yield* driver.intervalScan(
    table.tableName,
    indexName as string,
    clauses,
    selectOptions || {},
    driverOptions,
  );

  return validateRecordsFromDriver(table, records, options);
}

function* performInsert(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  records: Row[],
  options: CodecOptions,
  driverOptions?: DBDriverOperationOptions,
) {
  if (records.length === 0) return;
  const normalizedRecords = normalizeRecordsForDriver(table, records, options);
  yield* driver.insert(table.tableName, normalizedRecords, driverOptions);

  if (options.freezeRows) {
    deepFreeze(records);
    deepFreeze(normalizedRecords);
  }
}

function* performUpsert(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  records: Row[],
  options: CodecOptions,
  driverOptions?: DBDriverOperationOptions,
) {
  if (records.length === 0) return;
  const normalizedRecords = normalizeRecordsForDriver(table, records, options);
  yield* driver.upsert(table.tableName, normalizedRecords, driverOptions);

  if (options.freezeRows) {
    deepFreeze(records);
    deepFreeze(normalizedRecords);
  }
}

function* performDelete(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  ids: string[],
  driverOptions?: DBDriverOperationOptions,
) {
  if (ids.length === 0) return;
  yield* driver.delete(table.tableName, ids, driverOptions);
}

export class DB implements HyperDB {
  driver: DBDriver;
  traits: Trait[] = [];
  private state: DBState;

  constructor(driver: DBDriver, options?: DBOptions);
  constructor(driver: DBDriver, options: DBOptions = {}) {
    this.driver = driver;
    this.traits = options.traits ?? [];
    this.state = createDBState(options);
    if (options.register !== false) {
      registerHyperDB(this);
    }
  }

  withTraits(...traits: Trait[]): HyperDB {
    const db = Object.create(DB.prototype) as DB;
    db.driver = this.driver;
    db.traits = [...this.traits, ...traits];
    db.state = this.state;
    return db;
  }

  canUseReadonlyTransactionsForSelectors(): boolean {
    return this.driver.canUseReadonlyTransactionsForSelectors();
  }

  getTraits(): Trait[] {
    return this.traits;
  }

  getId(): string {
    return this.state.id;
  }

  getDBName(): string | undefined {
    return this.state.name;
  }

  getTracer(): HyperDBTracerOption | undefined {
    return this.state.tracer;
  }

  get options(): CodecOptions {
    return this.state.options;
  }

  getOptions(): CodecOptions {
    return this.state.options;
  }

  get tables(): TableDefinition<any, any>[] {
    return this.state.tables;
  }

  *loadTables(tables: TableDefinition<any, any>[]): Generator<DBCmd, void> {
    this.state.tables = tables;
    yield* this.driver.loadTables(tables);
  }

  *preloadTables<const TSpecs extends readonly HybridPreloadTableSpecInput[]>(
    _specs: TSpecs & ValidateHybridPreloadTableSpecs<TSpecs>,
  ): Generator<DBCmd, void> {}

  /** @internal Bulk source for runtimes that preload derived indexes. */
  *scanAll<TTable extends TableDefinition>(
    table: TTable,
  ): Generator<DBCmd, ExtractSchema<TTable>[]> {
    if (!this.driver.scanAll) {
      throw new Error(
        `Driver does not support startup index preloading for table: ${table.tableName}`,
      );
    }

    const records = yield* this.driver.scanAll(table.tableName, {
      traceContext: getDriverTraceContextForDB(this),
    });
    return validateRecordsFromDriver(table, records, this.options);
  }

  *beginTx(mode: DBTransactionMode = "readwrite"): Generator<DBCmd, DBTx> {
    const tx = yield* this.driver.beginTx(mode, {
      traceContext: getDriverTraceContextForDB(this),
    });
    return new DBTx(this, tx);
  }

  *intervalScan<
    TTable extends TableDefinition<any, any>,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Generator<DBCmd, ExtractSchema<TTable>[]> {
    return yield* performScan(
      this.driver,
      table,
      indexName as string,
      clauses,
      this.options,
      selectOptions,
      {
        traceContext: getDriverTraceContextForDB(this),
      },
    ) as Generator<DBCmd, ExtractSchema<TTable>[]>;
  }

  *insert<TTable extends TableDefinition<any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ) {
    yield* performInsert(this.driver, table, records as Row[], this.options, {
      traceContext: getDriverTraceContextForDB(this),
    });
  }

  *upsert<TTable extends TableDefinition<any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ) {
    yield* performUpsert(this.driver, table, records as Row[], this.options, {
      traceContext: getDriverTraceContextForDB(this),
    });
  }

  *delete<TTable extends TableDefinition<any, any>>(
    table: TTable,
    ids: string[],
  ) {
    yield* performDelete(this.driver, table, ids, {
      traceContext: getDriverTraceContextForDB(this),
    });
  }
}
