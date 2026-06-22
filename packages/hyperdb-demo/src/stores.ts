import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
import {
  AsyncSqlDriver,
  type AsyncSQLiteDB,
  type SqlValue,
} from "@will-be-done/hyperdb/drivers/sqlite";
import {
  DB,
  SubscribableDB,
  asyncDispatch,
  createAction,
  createSelector,
  deleteRows,
  execAsync,
  execSync,
  insert,
  selectAsync,
  selectFrom,
  syncDispatch,
  upsert,
  v,
  type DeleteOp,
  type HyperDB,
  type InsertOp,
  type Op,
  type UpsertOp,
} from "@will-be-done/hyperdb";
import {
  projectTaskStatsTable,
  projectsTable,
  taskStatsTable,
  tasksTable,
  type Project,
  type Task,
} from "./db";
import { installTaskStatsHooks } from "./count-hook";
import type { StoreMode } from "./store-mode";
import { PersistenceMonitor } from "./persistence-monitor";

const IDB_DIRECT_NAME = "hyperdb-demo-idb-direct";
const IDB_HYBRID_NAME = "hyperdb-demo";
const OPFS_DIRECT_DB_NAME = "hyperdb-demo-wa-sqlite-direct.sqlite";
const OPFS_HYBRID_DB_NAME = "hyperdb-demo-wa-sqlite-inmem.sqlite";

const ALL_TABLES = [
  projectsTable,
  tasksTable,
  taskStatsTable,
  projectTaskStatsTable,
];

const PERSISTED_TABLES = [projectsTable, tasksTable];
const PERSISTED_TABLE_NAMES = new Set(
  PERSISTED_TABLES.map((table) => table.tableName),
);

type PersistentBackend = "idb" | "wa-sqlite";

type WaSQLiteResponse =
  | { id: number; ok: true; rows?: SqlValue[][] }
  | { id: number; ok: false; error: string };

type WaSQLiteRequestInput =
  | {
      type: "exec";
      sql: string;
      params?: SqlValue[] | null;
    }
  | {
      type: "values";
      sql: string;
      values: SqlValue[];
    };

class WaSQLiteWorkerDB implements AsyncSQLiteDB {
  private worker = new Worker(
    new URL("./wa-sqlite-worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  private nextRequestId = 0;
  private databaseName: string;
  private pending = new Map<
    number,
    {
      resolve: (rows?: SqlValue[][]) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(databaseName: string) {
    this.databaseName = databaseName;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  async exec(sql: string, params?: SqlValue[] | null): Promise<void> {
    await this.request({ type: "exec", sql, params });
  }

  async prepare(sql: string) {
    return {
      values: (values: SqlValue[]) =>
        this.request({ type: "values", sql, values }).then(
          (rows) => rows ?? [],
        ),
      finalize: () => {},
    };
  }

  close(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();

    for (const { reject } of this.pending.values()) {
      reject(new Error("WA-SQLite worker was closed"));
    }
    this.pending.clear();
  }

  private request(
    input: WaSQLiteRequestInput,
  ): Promise<SqlValue[][] | undefined> {
    const id = ++this.nextRequestId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        databaseName: this.databaseName,
        ...input,
      });
    });
  }

  private handleMessage = (event: MessageEvent<WaSQLiteResponse>) => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.rows);
    } else {
      pending.reject(new Error(response.error));
    }
  };

  private handleError = (event: ErrorEvent | MessageEvent) => {
    const error =
      "error" in event && event.error instanceof Error
        ? event.error
        : new Error("WA-SQLite worker failed");

    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  };
}

function getBackend(mode: StoreMode): PersistentBackend {
  return mode === "idb" || mode === "idb-inmem" ? "idb" : "wa-sqlite";
}

function isHybridMode(mode: StoreMode): boolean {
  return mode === "idb-inmem" || mode === "wa-sqlite-inmem";
}

async function createPersistentDriver(mode: StoreMode) {
  const backend = getBackend(mode);
  const hybrid = isHybridMode(mode);

  if (backend === "idb") {
    return {
      driver: await openIndexedDBDriver(
        hybrid ? IDB_HYBRID_NAME : IDB_DIRECT_NAME,
      ),
      dbName: hybrid ? "demo-idb-inmem:persistent" : "demo-idb",
    };
  }

  const sqliteDb = new WaSQLiteWorkerDB(
    hybrid ? OPFS_HYBRID_DB_NAME : OPFS_DIRECT_DB_NAME,
  );
  return {
    driver: new AsyncSqlDriver(sqliteDb),
    dbName: hybrid ? "demo-wa-sqlite-inmem:persistent" : "demo-wa-sqlite",
  };
}

function createMemDb(mode: StoreMode): SubscribableDB {
  const baseDb = new DB(new BptreeInmemDriver(), {
    freezeArgs: false,
    freezeRows: false,
    dbName: "demo-inmem-" + mode,
  });
  execSync(baseDb.loadTables(ALL_TABLES));
  const db = new SubscribableDB(baseDb);
  installTaskStatsHooks(db);
  return db;
}

async function hydrate(persistentDB: HyperDB, memDB: SubscribableDB) {
  const { projects, tasks } = await selectAsync(
    persistentDB,
    scanPersistedTables({}),
  );

  if (projects.length > 0 || tasks.length > 0) {
    syncDispatch(memDB, loadIntoMemory({ projects, tasks }));
  }
}

function groupConsecutiveOps(ops: Op[]): Op[][] {
  const runs: Op[][] = [];
  for (const op of ops) {
    const last = runs.at(-1);
    if (last && last[0].type === op.type && last[0].table === op.table) {
      last.push(op);
    } else {
      runs.push([op]);
    }
  }
  return runs;
}

const action = createAction({ trace: { enabled: true, startOn: "load" } });
const selector = createSelector({ trace: { enabled: true, startOn: "load" } });

const scanPersistedTables = selector({
  name: "hydrate:scan",
  args: {},
  handler: function* scanPersistedTables() {
    const projects = yield* selectFrom(projectsTable, "byIds").order("asc");
    const tasks = yield* selectFrom(tasksTable, "byIds").order("asc");
    return { projects, tasks };
  },
});

const loadIntoMemory = action({
  name: "hydrate:load",
  args: { projects: v.pass<Project[]>(), tasks: v.pass<Task[]>() },
  handler: function* loadIntoMemory({ projects, tasks }) {
    if (projects.length > 0) yield* insert(projectsTable, projects);
    if (tasks.length > 0) yield* insert(tasksTable, tasks);
  },
});

const persistOps = action({
  name: "persist:batch",
  args: { ops: v.pass<Op[]>() },
  handler: function* persistOps({ ops }) {
    for (const run of groupConsecutiveOps(ops)) {
      const { type, table } = run[0];
      if (type === "insert") {
        yield* insert(
          table,
          run.map((op) => (op as InsertOp).newValue),
        );
      } else if (type === "upsert") {
        yield* upsert(
          table,
          run.map((op) => (op as UpsertOp).newValue),
        );
      } else {
        yield* deleteRows(
          table,
          run.map((op) => (op as DeleteOp).oldValue.id),
        );
      }
    }
  },
});

function startPersisting(
  persistentDB: HyperDB,
  memDB: SubscribableDB,
  monitor: PersistenceMonitor,
) {
  const pending: Op[][] = [];
  let draining = false;

  const syncQueue = () => {
    let pendingOps = 0;
    for (const batch of pending) pendingOps += batch.length;
    monitor.update({ pendingBatches: pending.length, pendingOps, draining });
  };

  async function persistBatch(ops: Op[]) {
    const startedAt = performance.now();
    await asyncDispatch(persistentDB, persistOps({ ops }));

    const durationMs = performance.now() - startedAt;
    monitor.update({
      lastDurationMs: durationMs,
      lastOpCount: ops.length,
      totalPersisted: monitor.getSnapshot().totalPersisted + ops.length,
    });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    syncQueue();
    try {
      while (pending.length > 0) {
        const batch = pending[0]!;
        try {
          await persistBatch(batch);
          pending.shift();
        } catch (err) {
          console.error("Failed to persist batch", err);
          break;
        }
        syncQueue();
      }
    } finally {
      draining = false;
      syncQueue();
    }
  }

  const unsubscribe = memDB.subscribe((ops) => {
    const persistable = ops.filter((op) =>
      PERSISTED_TABLE_NAMES.has(op.table.tableName),
    );
    if (persistable.length === 0) return;

    pending.push([...persistable]);
    syncQueue();
    void drain();
  });

  const flush = () => void drain();
  const beforeUnload = (event: BeforeUnloadEvent) => {
    flush();
    if (monitor.hasPendingWork()) {
      event.preventDefault();
      event.returnValue = "Saving persistent writes is still in progress.";
      return event.returnValue;
    }
  };
  window.addEventListener("pagehide", flush, { capture: true });
  window.addEventListener("beforeunload", beforeUnload, { capture: true });

  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush, { capture: true });
    window.removeEventListener("beforeunload", beforeUnload, { capture: true });
  };
}

export type InitResult = {
  db: SubscribableDB;
  persistence: PersistenceMonitor | null;
};

export async function initStore(mode: StoreMode): Promise<InitResult> {
  if (isHybridMode(mode)) {
    const memDB = createMemDb(mode);
    const { driver, dbName } = await createPersistentDriver(mode);
    const persistentDB = new DB(driver, { dbName });

    await execAsync(persistentDB.loadTables(PERSISTED_TABLES));
    await hydrate(persistentDB, memDB);

    const persistence = new PersistenceMonitor();
    startPersisting(persistentDB, memDB, persistence);

    return { db: memDB, persistence };
  }

  const { driver, dbName } = await createPersistentDriver(mode);
  const baseDb = new DB(driver, {
    freezeArgs: false,
    freezeRows: false,
    dbName,
  });
  const db = new SubscribableDB(baseDb);

  await execAsync(db.loadTables(ALL_TABLES));
  installTaskStatsHooks(db);

  return { db, persistence: null };
}
