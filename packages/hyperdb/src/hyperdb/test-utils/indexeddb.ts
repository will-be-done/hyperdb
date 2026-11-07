// Tests share one browser origin and run files in parallel, so database names
// must be unique across files, not just within one.
export const uniqueTestDBName = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID()}`;

const BLOCKED_DELETE_TIMEOUT_MS = 5_000;

/**
 * Deletes a test database. `blocked` only means a connection is still
 * finishing (for example a closed connection whose last transaction has not
 * completed); the delete proceeds once it does. Fail only if it stays blocked,
 * which points to a connection the test leaked.
 */
export function deleteTestIndexedDB(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(blockedTimer);
      reject(request.error ?? new Error("Failed to delete test database"));
    };
    request.onblocked = () => {
      blockedTimer ??= setTimeout(
        () =>
          reject(
            new Error(
              `IndexedDB delete of ${dbName} stayed blocked; a connection was left open`,
            ),
          ),
        BLOCKED_DELETE_TIMEOUT_MS,
      );
    };
  });
}
