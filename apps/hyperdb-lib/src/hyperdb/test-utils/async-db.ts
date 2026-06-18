/* eslint-disable @typescript-eslint/no-explicit-any */
import { execAsync } from "../core/executor";
import type { HyperDB, HyperDBTx } from "../core/contracts";
import type { SelectOptions, WhereClause } from "../core/primitives";
import type {
  ExtractIndexes,
  ExtractSchema,
  TableDefinition,
} from "../schema/table";

export class AsyncDBTx {
  private dbTx: HyperDBTx;

  constructor(dbTx: HyperDBTx) {
    this.dbTx = dbTx;
  }

  intervalScan<
    TTable extends TableDefinition<any, any, any>,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Promise<ExtractSchema<TTable>[]> {
    return execAsync(
      this.dbTx.intervalScan(table, indexName, clauses, selectOptions),
    );
  }

  insert<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Promise<void> {
    return execAsync(this.dbTx.insert(table, records));
  }

  upsert<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Promise<void> {
    return execAsync(this.dbTx.upsert(table, records));
  }

  delete<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    ids: string[],
  ): Promise<void> {
    return execAsync(this.dbTx.delete(table, ids));
  }

  commit(): Promise<void> {
    return execAsync(this.dbTx.commit());
  }

  rollback(): Promise<void> {
    return execAsync(this.dbTx.rollback());
  }
}

export class AsyncDB {
  private db: HyperDB;

  constructor(db: HyperDB) {
    this.db = db;
  }

  loadTables(tables: TableDefinition<any, any, any>[]): Promise<void> {
    return execAsync(this.db.loadTables(tables));
  }

  async beginTx(): Promise<AsyncDBTx> {
    return new AsyncDBTx(await execAsync(this.db.beginTx()));
  }

  intervalScan<
    TTable extends TableDefinition<any, any, any>,
    K extends keyof ExtractIndexes<TTable>,
  >(
    table: TTable,
    indexName: K,
    clauses: WhereClause[],
    selectOptions?: SelectOptions,
  ): Promise<ExtractSchema<TTable>[]> {
    return execAsync(this.db.intervalScan(table, indexName, clauses, selectOptions));
  }

  insert<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Promise<void> {
    return execAsync(this.db.insert(table, records));
  }

  upsert<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    records: ExtractSchema<TTable>[],
  ): Promise<void> {
    return execAsync(this.db.upsert(table, records));
  }

  delete<TTable extends TableDefinition<any, any, any>>(
    table: TTable,
    ids: string[],
  ): Promise<void> {
    return execAsync(this.db.delete(table, ids));
  }
}
