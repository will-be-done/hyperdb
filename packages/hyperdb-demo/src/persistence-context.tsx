import { createContext, useContext, useSyncExternalStore } from "react";
import type {
  PersistenceMonitor,
  PersistenceSnapshot,
} from "./persistence-monitor";

const PersistenceContext = createContext<PersistenceMonitor | null>(null);

export const PersistenceProvider = PersistenceContext.Provider;

const noopSubscribe = () => () => {};
const getNull = () => null;

/** Live persistence state, or `null` in memory mode. */
export function usePersistence(): PersistenceSnapshot | null {
  const monitor = useContext(PersistenceContext);
  return useSyncExternalStore(
    monitor?.subscribe ?? noopSubscribe,
    monitor?.getSnapshot ?? getNull,
  );
}
