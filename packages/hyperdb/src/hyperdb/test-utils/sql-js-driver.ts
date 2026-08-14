import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  AsyncSqlDriver,
  SqlDriver,
  type AsyncSqlDriverOptions,
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

export type SqlJsDriverHooks = {
  beforeExec?: (sql: string) => void;
  beforePrepare?: (sql: string) => void;
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
  hooks: SqlJsDriverHooks = {},
): { driver: SqlDriver; sqldb: InspectableSqlDatabase; execLog: string[] } {
  const log = execLog ?? [];

  return {
    sqldb,
    execLog: log,
    driver: new SqlDriver({
      exec(sql: string, params?: SqlValue[]): void {
        log.push(sql);
        hooks.beforeExec?.(sql);
        sqldb.exec(sql, params);
      },
      prepare(sql: string): SQLStatement {
        log.push(sql);
        hooks.beforePrepare?.(sql);
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
  private execLog?: string[];
  private hooks: SqlJsDriverHooks;

  constructor(
    sqldb: InspectableSqlDatabase,
    execLog?: string[],
    hooks: SqlJsDriverHooks = {},
  ) {
    this.sqldb = sqldb;
    this.execLog = execLog;
    this.hooks = hooks;
  }

  async exec(sql: string, params?: SqlValue[] | null): Promise<void> {
    this.execLog?.push(sql);
    this.hooks.beforeExec?.(sql);
    this.sqldb.exec(sql, params ?? undefined);
  }

  async prepare(sql: string) {
    this.execLog?.push(sql);
    this.hooks.beforePrepare?.(sql);
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

export async function createSqlJsAsyncDriver(
  options: AsyncSqlDriverOptions = {},
): Promise<AsyncSqlDriver> {
  const SQL = await initSqlJs({
    locateFile: () => normalizeWasmUrl(wasmUrl),
  });
  const sqldb: InspectableSqlDatabase = new SQL.Database();

  return new AsyncSqlDriver(new SqlJsAsyncAdapter(sqldb), options);
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

export async function createInspectableSqlAsyncDriver(
  options: AsyncSqlDriverOptions = {},
  hooks: SqlJsDriverHooks = {},
): Promise<{
  driver: AsyncSqlDriver;
  sqldb: InspectableSqlDatabase;
  execLog: string[];
}> {
  const SQL = await initSqlJs({
    locateFile: () => normalizeWasmUrl(wasmUrl),
  });
  const sqldb: InspectableSqlDatabase = new SQL.Database();
  const execLog: string[] = [];

  return {
    driver: new AsyncSqlDriver(
      new SqlJsAsyncAdapter(sqldb, execLog, hooks),
      options,
    ),
    sqldb,
    execLog,
  };
}
