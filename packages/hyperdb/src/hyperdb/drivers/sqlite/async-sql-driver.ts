import type { DBCmd } from "../../commands/async";
import { unwrap, unwrapCb } from "../../commands/async";
import type { BindParams, SqlValue } from "./sqlite-common";
import AwaitLock from "../../utils/await-lock";
import {
  SqliteDriverCore,
  type SqliteConnection,
  type SqliteLock,
  type SqliteOperation,
  type SqliteStatementInfo,
} from "./sqlite-driver-core";

export interface AsyncSQLStatement {
  values(values: SqlValue[]): Promise<SqlValue[][]>;
  finalize(): void | Promise<void>;
}
export interface AsyncSQLiteDB {
  exec(sql: string, params?: BindParams): Promise<void>;
  prepare(sql: string): AsyncSQLStatement | Promise<AsyncSQLStatement>;
}

export type AsyncSqlDriverDebugOperation = SqliteOperation;
export type AsyncSqlDriverDebugEvent = {
  operation: AsyncSqlDriverDebugOperation;
  status: "success" | "error";
  sql: string;
  normalizedSql: string;
  durationMs: number;
  tableName?: string;
  indexName?: string;
  rowCount?: number;
  paramCount?: number;
  params?: BindParams;
  truncatedParams?: number;
  error?: unknown;
};
export type AsyncSqlDriverDebug = (event: AsyncSqlDriverDebugEvent) => void;
export type AsyncSqlDriverOptions = {
  debug?: AsyncSqlDriverDebug;
};

export function formatAsyncSqlDriverDebugEvent(
  event: AsyncSqlDriverDebugEvent,
): string {
  const prefix = event.status === "error" ? "FAILED " : "";
  const rowCount =
    typeof event.rowCount === "number" ? ` | ${event.rowCount} rows` : "";

  return `${prefix}${event.normalizedSql} | ${event.durationMs}ms${rowCount}`;
}

export function logAsyncSqlDriverDebugEvent(
  event: AsyncSqlDriverDebugEvent,
): void {
  const message = `%c${formatAsyncSqlDriverDebugEvent(event)}`;

  if (event.status === "error") {
    console.error(message, "color: #facc15", event.error);
  } else {
    console.log(message, "color: #facc15");
  }
}

const SQL_PARAM_LOG_LIMIT = 40;

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function summarizeSqlParams(params?: BindParams) {
  if (!params) return undefined;

  return {
    paramCount: params.length,
    params:
      params.length <= SQL_PARAM_LOG_LIMIT
        ? params
        : params.slice(0, SQL_PARAM_LOG_LIMIT),
    truncatedParams:
      params.length > SQL_PARAM_LOG_LIMIT
        ? params.length - SQL_PARAM_LOG_LIMIT
        : 0,
  };
}

// The statement has already run, so a throwing hook must not turn its result
// into a failure (a COMMIT would look failed after it applied).
function report(
  debug: AsyncSqlDriverDebug,
  event: AsyncSqlDriverDebugEvent,
): void {
  try {
    debug(event);
  } catch (error) {
    console.error("AsyncSqlDriver debug hook threw", error);
  }
}

class AsyncConnection implements SqliteConnection {
  private db: AsyncSQLiteDB;
  private debug: AsyncSqlDriverDebug | undefined;

  constructor(db: AsyncSQLiteDB, debug: AsyncSqlDriverDebug | undefined) {
    this.db = db;
    this.debug = debug;
  }

  exec(
    sql: string,
    params?: SqlValue[],
    info: SqliteStatementInfo = { operation: "exec" },
  ): Generator<DBCmd, void> {
    return unwrapCb(() =>
      this.observe(sql, params, info, async () => {
        await this.db.exec(sql, params);
        return info.rowCount;
      }),
    );
  }

  query(
    sql: string,
    params: SqlValue[] = [],
    info: SqliteStatementInfo = { operation: "scan" },
  ): Generator<DBCmd, SqlValue[][]> {
    return unwrapCb(async () => {
      let rows: SqlValue[][] = [];
      await this.observe(sql, params, info, async () => {
        const statement = await this.db.prepare(sql);
        try {
          rows = await statement.values(params);
        } finally {
          await statement.finalize();
        }
        return info.rowCount ?? rows.length;
      });
      return rows;
    });
  }

  // Runs one statement and reports it to the debug hook.
  private async observe(
    sql: string,
    params: SqlValue[] | undefined,
    info: SqliteStatementInfo,
    run: () => Promise<number | undefined>,
  ): Promise<void> {
    const debug = this.debug;
    if (!debug) {
      await run();
      return;
    }

    const startedAt = nowMs();
    const event = (rowCount: number | undefined) => ({
      operation: info.operation,
      sql,
      normalizedSql: sql.replace(/\s+/g, " ").trim(),
      durationMs: Math.round(nowMs() - startedAt),
      ...(info.tableName === undefined ? {} : { tableName: info.tableName }),
      ...(info.indexName === undefined ? {} : { indexName: info.indexName }),
      ...(rowCount === undefined ? {} : { rowCount }),
      ...summarizeSqlParams(params),
    });

    let rowCount: number | undefined;
    try {
      rowCount = await run();
    } catch (error) {
      if (!info.expectedError?.(error)) {
        report(debug, { ...event(info.rowCount), status: "error", error });
      }
      throw error;
    }
    report(debug, { ...event(rowCount), status: "success" });
  }
}

class AsyncLock implements SqliteLock {
  private lock = new AwaitLock();

  *acquire(): Generator<DBCmd, void> {
    // The wait starts before the executor sees it. If the executor then
    // throws instead (a sync caller cannot wait) or abandons the generator,
    // hand the lock back as soon as it is ours, or it stays held forever.
    const acquired = this.lock.acquireAsync();
    let held = false;
    try {
      yield* unwrap(acquired);
      held = true;
    } finally {
      if (!held) void acquired.then(() => this.lock.release());
    }
  }

  release(): void {
    this.lock.release();
  }
}

/** SQLite driver for promise-based bindings such as Turso or wa-sqlite. */
export class AsyncSqlDriver extends SqliteDriverCore {
  constructor(db: AsyncSQLiteDB, options: AsyncSqlDriverOptions = {}) {
    super({
      connection: new AsyncConnection(db, options.debug),
      driverLock: new AsyncLock(),
      createTxLock: () => new AsyncLock(),
    });
  }
}
