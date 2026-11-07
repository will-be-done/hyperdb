import type { DBCmd } from "../../commands/async";
import type { BindParams, SqlValue } from "./sqlite-common";
import {
  SqliteDriverCore,
  type SqliteConnection,
  type SqliteLock,
} from "./sqlite-driver-core";

export interface SQLStatement {
  values(values: SqlValue[]): SqlValue[][];
  finalize(): void;
}
export interface SQLiteDB {
  exec(sql: string, params?: BindParams): void;
  prepare(sql: string): SQLStatement;
}

// Never yields, so every driver operation completes under execSync.
class SyncConnection implements SqliteConnection {
  private db: SQLiteDB;

  constructor(db: SQLiteDB) {
    this.db = db;
  }

  *exec(sql: string, params?: SqlValue[]): Generator<DBCmd, void> {
    this.db.exec(sql, params);
  }

  *query(sql: string, params: SqlValue[] = []): Generator<DBCmd, SqlValue[][]> {
    const statement = this.db.prepare(sql);
    try {
      return statement.values(params);
    } finally {
      statement.finalize();
    }
  }
}

// A sync caller cannot wait, so an operation started while a transaction is
// open fails instead of queueing.
class SyncLock implements SqliteLock {
  private held = false;

  *acquire(): Generator<DBCmd, void> {
    if (this.held) {
      throw new Error("can't run while transaction is in progress");
    }
    this.held = true;
  }

  release(): void {
    this.held = false;
  }
}

/** SQLite driver for synchronous bindings such as sql.js. */
export class SqlDriver extends SqliteDriverCore {
  constructor(db: SQLiteDB) {
    super({
      connection: new SyncConnection(db),
      driverLock: new SyncLock(),
      // Statements of a sync transaction cannot interleave.
      createTxLock: () => new SyncLock(),
    });
  }
}
