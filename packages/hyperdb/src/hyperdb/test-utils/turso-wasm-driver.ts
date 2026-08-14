import { afterEach } from "vitest";
import {
  connect,
  type Database as TursoDatabase,
} from "@tursodatabase/database-wasm/bundle";
import {
  AsyncSqlDriver,
  type AsyncSqlDriverOptions,
  type AsyncSQLiteDB,
  type SqlValue,
} from "../drivers/sqlite";

const openDatabases = new Set<TursoDatabase>();

afterEach(async () => {
  await Promise.all(
    [...openDatabases].map(async (database) => {
      await database.close();
    }),
  );
  openDatabases.clear();
});

class TursoWasmAsyncAdapter implements AsyncSQLiteDB {
  private readonly database: TursoDatabase;

  constructor(database: TursoDatabase) {
    this.database = database;
  }

  async exec(sql: string, params?: SqlValue[]): Promise<void> {
    if (!params || params.length === 0) {
      await this.database.exec(sql);
      return;
    }

    const statement = await this.database.prepare(sql);
    try {
      await statement.run(params);
    } finally {
      statement.close();
    }
  }

  async prepare(sql: string) {
    const statement = (await this.database.prepare(sql)).raw(true);

    return {
      async values(values: SqlValue[]): Promise<SqlValue[][]> {
        return (await statement.all(values)) as SqlValue[][];
      },
      finalize(): void {
        statement.close();
      },
    };
  }
}

export async function createTursoWasmDriver(
  options: AsyncSqlDriverOptions = {},
): Promise<AsyncSqlDriver> {
  const database = await connect(":memory:");
  openDatabases.add(database);

  return new AsyncSqlDriver(new TursoWasmAsyncAdapter(database), options);
}
