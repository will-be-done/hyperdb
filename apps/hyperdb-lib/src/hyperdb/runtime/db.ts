/* eslint-disable @typescript-eslint/no-explicit-any */
import { convertWhereToBound } from "../core/query/bounds";
import type { DBCmd } from "../commands/async";
import type { HyperDB } from "../core/contracts";
import type { BaseDBDriverOperations, DBDriver } from "../core/driver";
import type {
  Row,
  SelectOptions,
  Trait,
  WhereClause,
} from "../core/primitives";
import type { HyperDBTracer } from "../core/tracer";
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
import { DBTx } from "./db-tx";

export type DBOptions = Partial<CodecOptions> & {
  traits?: Trait[];
  trace?: boolean;
  autoTrace?: boolean;
  tracer?: HyperDBTracer | null;
};

type DBState = {
  tables: TableDefinition<any, any>[];
  options: CodecOptions;
  id: string;
  trace: boolean;
  autoTrace: boolean;
  tracer?: HyperDBTracer | null;
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
  const { trace = false, autoTrace = true } = options;

  return {
    tables: [],
    options: {
      ...DEFAULT_CODEC_OPTIONS,
      runtimeValidation: options.runtimeValidation ?? false,
      freezeArgs: options.freezeArgs ?? false,
      freezeRows: options.freezeRows ?? false,
    },
    id: createDBId(),
    trace,
    autoTrace,
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
  );

  return validateRecordsFromDriver(table, records, options);
}

function* performInsert(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  records: Row[],
  options: CodecOptions,
) {
  if (records.length === 0) return;
  const normalizedRecords = normalizeRecordsForDriver(table, records, options);
  yield* driver.insert(table.tableName, normalizedRecords);

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
) {
  if (records.length === 0) return;
  const normalizedRecords = normalizeRecordsForDriver(table, records, options);
  yield* driver.upsert(table.tableName, normalizedRecords);

  if (options.freezeRows) {
    deepFreeze(records);
    deepFreeze(normalizedRecords);
  }
}

function* performDelete(
  driver: BaseDBDriverOperations,
  table: TableDefinition,
  ids: string[],
) {
  if (ids.length === 0) return;
  yield* driver.delete(table.tableName, ids);
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
  }

  withTraits(...traits: Trait[]): HyperDB {
    const db = new DB(this.driver, {
      traits: [...this.traits, ...traits],
    });
    db.state = this.state;
    return db;
  }

  getTraits(): Trait[] {
    return this.traits;
  }

  getId(): string {
    return this.state.id;
  }

  getTraceEnabled(): boolean {
    return this.state.trace;
  }

  getAutoTraceEnabled(): boolean {
    return this.state.autoTrace;
  }

  getTracer(): HyperDBTracer | null | undefined {
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

  *beginTx(): Generator<DBCmd, DBTx> {
    const tx = yield* this.driver.beginTx();
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
    ) as Generator<DBCmd, ExtractSchema<TTable>[]>;
  }

  *insert<TTable extends TableDefinition<any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ) {
    yield* performInsert(this.driver, table, records as Row[], this.options);
  }

  *upsert<TTable extends TableDefinition<any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ) {
    yield* performUpsert(this.driver, table, records as Row[], this.options);
  }

  *delete<TTable extends TableDefinition<any, any>>(
    table: TTable,
    ids: string[],
  ) {
    yield* performDelete(this.driver, table, ids);
  }
}
