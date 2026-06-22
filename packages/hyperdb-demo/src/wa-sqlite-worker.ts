/// <reference lib="webworker" />

import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import asyncSqlWasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import * as SQLite from "wa-sqlite";
import { OriginPrivateFileSystemVFS } from "wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js";
import type { SqlValue } from "@will-be-done/hyperdb/drivers/sqlite";

type WaSQLiteValue =
  | number
  | string
  | Uint8Array
  | Array<number>
  | bigint
  | null;

type WaSQLiteAPI = {
  bind_collection(
    stmt: number,
    bindings:
      | { [index: string]: WaSQLiteValue | null }
      | Array<WaSQLiteValue | null>,
  ): number;
  statements(db: number, sql: string): AsyncIterable<number>;
  step(stmt: number): Promise<number>;
  row(stmt: number): WaSQLiteValue[];
  vfs_register(vfs: unknown, makeDefault: boolean): void;
  open_v2(name: string): Promise<number>;
};

type WorkerRequest =
  | {
      id: number;
      databaseName: string;
      type: "exec";
      sql: string;
      params?: SqlValue[] | null;
    }
  | {
      id: number;
      databaseName: string;
      type: "values";
      sql: string;
      values: SqlValue[];
    };

type Connection = {
  sqlite3: WaSQLiteAPI;
  dbHandle: number;
};

const SQLITE_ROW = 100;
let connectionPromise: Promise<Connection> | null = null;

async function createConnection(databaseName: string): Promise<Connection> {
  const module = await SQLiteAsyncESMFactory({
    locateFile: () => asyncSqlWasmUrl,
  });
  const sqlite3 = SQLite.Factory(module) as WaSQLiteAPI;
  const vfs = new OriginPrivateFileSystemVFS();
  sqlite3.vfs_register(vfs, true);

  return {
    sqlite3,
    dbHandle: await sqlite3.open_v2(databaseName),
  };
}

function getConnection(databaseName: string): Promise<Connection> {
  connectionPromise ??= createConnection(databaseName);
  return connectionPromise;
}

async function execSQL(
  connection: Connection,
  sql: string,
  params?: SqlValue[] | null,
): Promise<void> {
  for await (const stmt of connection.sqlite3.statements(
    connection.dbHandle,
    sql,
  )) {
    if (params) connection.sqlite3.bind_collection(stmt, params);
    await connection.sqlite3.step(stmt);
  }
}

async function readValues(
  connection: Connection,
  sql: string,
  values: SqlValue[],
): Promise<SqlValue[][]> {
  const rows: SqlValue[][] = [];

  for await (const stmt of connection.sqlite3.statements(
    connection.dbHandle,
    sql,
  )) {
    connection.sqlite3.bind_collection(stmt, values);

    while ((await connection.sqlite3.step(stmt)) === SQLITE_ROW) {
      rows.push(connection.sqlite3.row(stmt) as SqlValue[]);
    }
  }

  return rows;
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  void (async () => {
    try {
      const connection = await getConnection(request.databaseName);

      if (request.type === "exec") {
        await execSQL(connection, request.sql, request.params);
        self.postMessage({ id: request.id, ok: true });
      } else {
        const rows = await readValues(connection, request.sql, request.values);
        self.postMessage({ id: request.id, ok: true, rows });
      }
    } catch (error) {
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

export {};
