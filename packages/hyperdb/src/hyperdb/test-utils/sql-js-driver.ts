import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  AsyncSqlDriver,
  SqlDriver,
  type AsyncSQLiteDB,
  type SQLStatement,
} from "../drivers/sqlite";
import type { SqlValue } from "../drivers/sqlite";

function normalizeWasmUrl(url: string): string {
  if (typeof window !== "undefined") {
    return url;
  }

  if (url.startsWith("/@fs/")) {
    return url.slice("/@fs".length);
  }

  return url;
}

export type InspectableSqlDatabase = {
  exec(sql: string, params?: SqlValue[]): { values: SqlValue[][] }[];
  prepare(sql: string): {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    get(): SqlValue[];
    getColumnNames(): string[];
    free(): boolean;
  };
};

export async function createSqlJsDriver(): Promise<SqlDriver> {
  const SQL = await initSqlJs({
    locateFile: () => normalizeWasmUrl(wasmUrl),
  });
  const sqldb: InspectableSqlDatabase = new SQL.Database();

  return createSqlJsDriverFromDatabase(sqldb).driver;
}

export function createSqlJsDriverFromDatabase(
  sqldb: InspectableSqlDatabase,
  execLog?: string[],
): { driver: SqlDriver; sqldb: InspectableSqlDatabase; execLog: string[] } {
  const log = execLog ?? [];

  return {
    sqldb,
    execLog: log,
    driver: new SqlDriver({
      exec(sql: string, params?: SqlValue[]): void {
        log.push(sql);
        sqldb.exec(sql, params);
      },
      prepare(sql: string): SQLStatement {
        log.push(sql);
        const prepared = sqldb.prepare(sql);

        return {
          values(values: SqlValue[]): SqlValue[][] {
            prepared.bind(values);

            const result: SqlValue[][] = [];
            while (prepared.step()) {
              result.push(prepared.get());
            }

            return result;
          },
          finalize(): void {
            prepared.free();
          },
        };
      },
    }),
  };
}

class SqlJsAsyncAdapter implements AsyncSQLiteDB {
  private sqldb: InspectableSqlDatabase;

  constructor(sqldb: InspectableSqlDatabase) {
    this.sqldb = sqldb;
  }

  async exec(sql: string, params?: SqlValue[] | null): Promise<void> {
    this.sqldb.exec(sql, params ?? undefined);
  }

  async prepare(sql: string) {
    const prepared = this.sqldb.prepare(sql);

    return {
      async values(values: SqlValue[]): Promise<SqlValue[][]> {
        prepared.bind(values);

        const result: SqlValue[][] = [];
        while (prepared.step()) {
          result.push(prepared.get());
        }

        return result;
      },
      async finalize(): Promise<void> {
        prepared.free();
      },
    };
  }
}

export async function createSqlJsAsyncDriver(): Promise<AsyncSqlDriver> {
  const SQL = await initSqlJs({
    locateFile: () => normalizeWasmUrl(wasmUrl),
  });
  const sqldb: InspectableSqlDatabase = new SQL.Database();

  return new AsyncSqlDriver(new SqlJsAsyncAdapter(sqldb));
}

export async function createInspectableSqlDriver(): Promise<{
  driver: SqlDriver;
  sqldb: InspectableSqlDatabase;
  execLog: string[];
}> {
  const SQL = await initSqlJs({
    locateFile: () => normalizeWasmUrl(wasmUrl),
  });
  const sqldb: InspectableSqlDatabase = new SQL.Database();

  return createSqlJsDriverFromDatabase(sqldb);
}
