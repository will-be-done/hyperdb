export type StoreMode = "idb" | "idb-inmem" | "wa-sqlite" | "wa-sqlite-inmem";

const STORAGE_KEY = "hyperdb-demo-mode";
const modes = new Set<StoreMode>([
  "idb",
  "idb-inmem",
  "wa-sqlite",
  "wa-sqlite-inmem",
]);

/** Read the persisted storage mode. Defaults to the IDB + in-memory tier. */
export function getStoredMode(): StoreMode {
  try {
    const storedMode = localStorage.getItem(STORAGE_KEY);
    if (storedMode === "persistent") return "idb-inmem";
    if (storedMode === "indexeddb") return "idb";
    if (storedMode === "wa-sqlite-opfs") return "wa-sqlite";
    return modes.has(storedMode as StoreMode)
      ? (storedMode as StoreMode)
      : "idb-inmem";
  } catch {
    return "idb-inmem";
  }
}

/** Remember the user's choice so it survives reloads. */
export function setStoredMode(mode: StoreMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures (private mode, quota, etc.)
  }
}
