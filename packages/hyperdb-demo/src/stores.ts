import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { openIndexedDBDriver } from "@will-be-done/hyperdb/drivers/idb";
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
  type HyperDB,
  type Op,
  type InsertOp,
  type UpsertOp,
  type DeleteOp,
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

const IDB_NAME = "hyperdb-demo";

// All tables live in the in-memory tier the UI talks to.
const ALL_TABLES = [
  projectsTable,
  tasksTable,
  taskStatsTable,
  projectTaskStatsTable,
];

// Only the base data is persisted; the stats tables are derived and rebuilt by
// the afterChange hooks when rows hydrate back into memory.
const PERSISTED_TABLES = [projectsTable, tasksTable];
const PERSISTED_TABLE_NAMES = new Set(
  PERSISTED_TABLES.map((table) => table.tableName),
);

/**
 * Build the synchronous in-memory tier the UI reads and writes, with the
 * derived-stats hooks installed.
 */
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

/** Read every persisted row from IndexedDB and load it into the in-memory tier. */
async function hydrate(persistentDB: HyperDB, memDB: SubscribableDB) {
  const { projects, tasks } = await selectAsync(
    persistentDB,
    scanPersistedTables({}),
  );

  if (projects.length > 0 || tasks.length > 0) {
    syncDispatch(memDB, loadIntoMemory({ projects, tasks }));
  }
}

/**
 * Split ops into runs of the same type + table, keeping their original order.
 * One bulk insert collapses into a single run the driver can pipeline, while an
 * interleaved insert/delete of the same row stays in two ordered runs.
 */
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

// Traced builders, so the persistence reads/writes show up in the devtool
// timeline alongside the app's own actions and selectors.
const action = createAction({ trace: { enabled: true, startOn: "load" } });
const selector = createSelector({ trace: { enabled: true, startOn: "load" } });

// Full-table scan over each table's `byIds` btree index — this is the read you
// can watch in the trace to see what hydrating from IndexedDB actually costs.
const scanPersistedTables = selector({
  name: "hydrate:scan",
  args: {},
  handler: function* scanPersistedTables() {
    const projects = yield* selectFrom(projectsTable, "byIds").order("asc");
    const tasks = yield* selectFrom(tasksTable, "byIds").order("asc");
    return { projects, tasks };
  },
});

// Load the scanned rows into the in-memory tier (fires the afterChange hooks,
// which rebuild the derived stats tables from scratch).
const loadIntoMemory = action({
  name: "hydrate:load",
  args: { projects: v.pass<Project[]>(), tasks: v.pass<Task[]>() },
  handler: function* loadIntoMemory({ projects, tasks }) {
    if (projects.length > 0) yield* insert(projectsTable, projects);
    if (tasks.length > 0) yield* insert(tasksTable, tasks);
  },
});

// Apply one commit's worth of ops to the persistent tier. Coalesced into one
// call per run, so a bulk insert is a single `insert` span the driver can
// pipeline — the write you can watch to see how fast it lands on disk.
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

/** Mirror each in-memory commit to the persistent tier, one batch at a time. */
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
    // asyncDispatch opens a tx, runs the (traced) action, and commits — or rolls
    // back on failure. The op coalescing lives inside the `persistOps` action.
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
        const batch = pending.shift()!;
        try {
          await persistBatch(batch);
        } catch (err) {
          console.error("Failed to persist batch", err);
        }
        syncQueue();
      }
    } finally {
      draining = false;
      syncQueue();
    }
  }

  const unsubscribe = memDB.subscribe((ops) => {
    // Only the base tables go to disk; the derived-stats ops are recomputed on
    // hydrate, so skip them here.
    const persistable = ops.filter((op) =>
      PERSISTED_TABLE_NAMES.has(op.table.tableName),
    );
    if (persistable.length === 0) return;

    pending.push([...persistable]);
    syncQueue();
    void drain();
  });

  const flush = () => void drain();
  // Warn before the tab is closed/reloaded if there is still unpersisted work.
  const beforeUnload = (event: BeforeUnloadEvent) => {
    flush(); // best-effort flush; can't be awaited here
    if (monitor.hasPendingWork()) {
      event.preventDefault();
      // Modern browsers ignore the text but require a value to show the prompt.
      event.returnValue = "Saving to IndexedDB is still in progress.";
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
  /** Present only in persistent mode. */
  persistence: PersistenceMonitor | null;
};

/**
 * Build the database the app talks to for the given mode. In "memory" mode this
 * is a plain in-memory tier; in "persistent" mode the same tier is hydrated from
 * IndexedDB and every change is mirrored back to disk.
 */
export async function initStore(mode: StoreMode): Promise<InitResult> {
  const memDB = createMemDb(mode);
  if (mode === "memory") return { db: memDB, persistence: null };

  const persistentDB = new DB(await openIndexedDBDriver(IDB_NAME), {
    dbName: "demo-indexeddb-" + mode,
  });
  await execAsync(persistentDB.loadTables(PERSISTED_TABLES));

  await hydrate(persistentDB, memDB);
  const persistence = new PersistenceMonitor();
  startPersisting(persistentDB, memDB, persistence);

  return { db: memDB, persistence };
}
