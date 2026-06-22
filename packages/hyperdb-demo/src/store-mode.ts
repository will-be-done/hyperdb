export type StoreMode = "memory" | "persistent";

const STORAGE_KEY = "hyperdb-demo-mode";

/** Read the persisted storage mode. Defaults to the synchronous in-memory tier. */
export function getStoredMode(): StoreMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "persistent"
      ? "persistent"
      : "memory";
  } catch {
    return "memory";
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
