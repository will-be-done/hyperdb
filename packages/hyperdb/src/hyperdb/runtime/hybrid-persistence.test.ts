import { describe, expect, it, vi } from "vitest";
import { unwrap } from "../commands/async";
import { execAsync, execSync } from "../core/executor";
import { BptreeInmemDriver } from "../drivers/inmemory/bptree-inmem-driver";
import { defineTable } from "../schema/table";
import { v } from "../schema/values";
import { DB } from "./db";
import {
  coalescePersistenceWrites,
  HybridDBCrashedError,
  HybridPersistenceQueue,
  type HybridPendingWrite,
} from "./hybrid-persistence";

const table = defineTable("persistenceRows", { id: v.string() });
const write = (id: string, insertOnly = false): HybridPendingWrite => ({
  table,
  id,
  newValue: { id },
  insertOnly,
  oldValueKnown: false,
});

describe("HybridPersistenceQueue", () => {
  it.each([false, true])(
    "preserves retry and crash behavior when the observer throws (permanent failure: %s)",
    async (permanentFailure) => {
      const primary = new DB(new BptreeInmemDriver());
      execSync(primary.loadTables([table]));
      const begin = primary.beginTx.bind(primary);
      const error = new Error("storage unavailable");
      let attempts = 0;
      vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
        attempts++;
        if (permanentFailure || attempts === 1) throw error;
        return yield* begin(mode);
      });
      const observer = vi.fn(() => {
        throw new Error("observer failed");
      });
      const queue = new HybridPersistenceQueue();
      queue.enqueue(primary, [write("first")], observer);
      const pending = [...queue.pending][0]!.promise;

      if (permanentFailure) {
        await expect(pending).rejects.toBe(error);
        expect(queue.isCrashed).toBe(true);
        expect(() => queue.throwIfCrashed()).toThrow(HybridDBCrashedError);
        await expect(
          execAsync(queue.waitForPersistence()),
        ).rejects.toMatchObject({
          cause: error,
        });
        expect(attempts).toBe(3);
        expect(observer).toHaveBeenCalledTimes(3);
      } else {
        await pending;
        expect(queue.isCrashed).toBe(false);
        expect(execSync(primary.scanAll(table))).toEqual([{ id: "first" }]);
        expect(attempts).toBe(2);
        expect(observer).toHaveBeenCalledTimes(1);
      }
      expect(queue.pending.size).toBe(0);
    },
  );

  it("rejects excess batches without retaining them and resumes in order after draining", async () => {
    const primary = new DB(new BptreeInmemDriver());
    execSync(primary.loadTables([table]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begin = primary.beginTx.bind(primary);
    let attempts = 0;
    vi.spyOn(primary, "beginTx").mockImplementation(function* (mode) {
      attempts++;
      yield* unwrap(gate);
      if (attempts === 1) throw new Error("transient failure");
      return yield* begin(mode);
    });
    const queue = new HybridPersistenceQueue();
    const persisted: string[] = [];
    for (let i = 0; i < HybridPersistenceQueue.maxPendingBatches; i++) {
      queue.enqueue(primary, [write(String(i))]);
      void [...queue.pending].at(-1)!.promise.then(() => {
        persisted.push(String(i));
      });
    }
    expect(() => queue.enqueue(primary, [write("excess")])).toThrow(
      "queue is full",
    );
    expect(() => queue.enqueue(primary, [])).not.toThrow();
    expect(queue.pending.size).toBe(HybridPersistenceQueue.maxPendingBatches);
    release();
    await execAsync(queue.waitForPersistence());
    expect(attempts).toBe(HybridPersistenceQueue.maxPendingBatches + 1);
    expect(persisted).toEqual(
      Array.from({ length: HybridPersistenceQueue.maxPendingBatches }, (_, i) =>
        String(i),
      ),
    );
    expect(queue.pending.size).toBe(0);
    queue.enqueue(primary, [write("after-drain")]);
    await execAsync(queue.waitForPersistence());
    expect(execSync(primary.scanAll(table))).toHaveLength(
      HybridPersistenceQueue.maxPendingBatches + 1,
    );
  });
});

describe("coalescePersistenceWrites", () => {
  it("retains the first write's insert intent through subsequent writes", () => {
    const inserted = write("inserted", true);
    const updated = {
      ...inserted,
      newValue: { id: "inserted", title: "latest" },
      insertOnly: false,
    };
    const deleted: HybridPendingWrite = {
      table,
      id: "replaced",
      oldValueKnown: false,
    };
    const replaced = write("replaced", true);
    const removed: HybridPendingWrite = {
      table,
      id: "removed",
      oldValueKnown: false,
    };
    expect(
      coalescePersistenceWrites([
        inserted,
        updated,
        deleted,
        replaced,
        write("removed", true),
        removed,
      ]),
    ).toEqual([
      { ...updated, insertOnly: true },
      { ...replaced, insertOnly: undefined },
      { ...removed, insertOnly: true },
    ]);
    expect(updated.insertOnly).toBe(false);
  });
});
