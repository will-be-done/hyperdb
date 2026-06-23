import { getTraceDBInfo } from "./db-info";

export type RegisteredHyperDBInfo = {
  id: string;
  label: string;
  source: "db";
};

type RegisteredHyperDBListener = (dbs: RegisteredHyperDBInfo[]) => void;

type HyperDBRuntimeRegistry = {
  dbs: Map<string, RegisteredHyperDBInfo>;
  listeners: Set<RegisteredHyperDBListener>;
};

type HyperDBGlobal = typeof globalThis & {
  __hyperdb?: HyperDBRuntimeRegistry;
};

const getRegistry = (): HyperDBRuntimeRegistry => {
  const target = globalThis as HyperDBGlobal;

  if (!target.__hyperdb) {
    target.__hyperdb = {
      dbs: new Map(),
      listeners: new Set(),
    };
  }

  return target.__hyperdb;
};

const snapshotRegisteredDBs = (
  registry: HyperDBRuntimeRegistry,
): RegisteredHyperDBInfo[] =>
  [...registry.dbs.values()].map((db) => ({ ...db }));

const emitRegisteredDBEvent = (info: RegisteredHyperDBInfo): void => {
  const eventTarget = globalThis as typeof globalThis & {
    dispatchEvent?: (event: Event) => boolean;
    CustomEvent?: typeof CustomEvent;
  };

  if (typeof eventTarget.dispatchEvent !== "function") return;

  try {
    const EventCtor = eventTarget.CustomEvent ?? globalThis.CustomEvent;
    const event =
      typeof EventCtor === "function"
        ? new EventCtor("hyperdb:db-registered", { detail: info })
        : new Event("hyperdb:db-registered");
    eventTarget.dispatchEvent(event);
  } catch {
    // The registry itself is the primary signal; browser events are best-effort.
  }
};

export const registerHyperDB = (db: object): RegisteredHyperDBInfo => {
  const registry = getRegistry();
  const dbInfo = getTraceDBInfo(db);
  const previous = registry.dbs.get(dbInfo.id);
  const next: RegisteredHyperDBInfo = {
    id: dbInfo.id,
    label: dbInfo.label,
    source: "db",
  };

  if (
    previous &&
    previous.label === next.label &&
    previous.source === next.source
  ) {
    return { ...previous };
  }

  registry.dbs.set(next.id, next);
  const snapshot = snapshotRegisteredDBs(registry);

  for (const listener of [...registry.listeners]) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("Failed to notify HyperDB registry listener", error);
    }
  }

  emitRegisteredDBEvent(next);
  return { ...next };
};

export const getRegisteredHyperDBs = (): RegisteredHyperDBInfo[] =>
  snapshotRegisteredDBs(getRegistry());

export const subscribeToRegisteredHyperDBs = (
  listener: RegisteredHyperDBListener,
): (() => void) => {
  const registry = getRegistry();
  registry.listeners.add(listener);

  return () => {
    registry.listeners.delete(listener);
  };
};
