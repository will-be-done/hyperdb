import { describe, expect, it } from "vitest";
import type { BaseDBDriverOperations } from "../../core/driver";
import type { Row } from "../../core/primitives";
import { execSync } from "../../core/executor";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { BptreeInmemDriver } from "./bptree-inmem-driver";

const forkedTxTable = defineTable("inmemBtreeForkedTx", {
  id: v.string(),
  rank: v.number(),
  status: v.string(),
  title: v.string(),
})
  .index("byRank", ["rank"])
  .index("byStatus", ["status"], { type: "hash" });

type IndexedTask = {
  id: string;
  rank: number;
  status: string;
  title: string;
};

type IndexCase = {
  name: string;
  scan: (db: BaseDBDriverOperations, key: number | string) => Row[];
  oldKey: number | string;
  newKey: number | string;
  insertedKey: number | string;
  deletedKey: number | string;
  original: IndexedTask;
  updated: IndexedTask;
  inserted: IndexedTask;
  deleted: IndexedTask;
};

function scanByRank(db: BaseDBDriverOperations, rank: number): Row[] {
  return execSync(
    db.intervalScan(
      forkedTxTable.tableName,
      "byRank",
      [{ eq: [{ col: "rank", val: rank }] }],
      {},
    ),
  ) as Row[];
}

function scanByStatus(db: BaseDBDriverOperations, status: string): Row[] {
  return execSync(
    db.intervalScan(
      forkedTxTable.tableName,
      "byStatus",
      [{ eq: [{ col: "status", val: status }] }],
      {},
    ),
  ) as Row[];
}

const createDriver = (records: IndexedTask[] = []) => {
  const driver = new BptreeInmemDriver();
  execSync(driver.loadTables([forkedTxTable]));
  if (records.length > 0) {
    execSync(driver.insert(forkedTxTable.tableName, records));
  }
  return driver;
};

const indexCases: IndexCase[] = [
  {
    name: "btree",
    scan: (db, key) => scanByRank(db, key as number),
    oldKey: 10,
    newKey: 20,
    insertedKey: 30,
    deletedKey: 40,
    original: {
      id: "btree-original",
      rank: 10,
      status: "btree-original-status",
      title: "Btree Original",
    },
    updated: {
      id: "btree-original",
      rank: 20,
      status: "btree-updated-status",
      title: "Btree Updated",
    },
    inserted: {
      id: "btree-inserted",
      rank: 30,
      status: "btree-inserted-status",
      title: "Btree Inserted",
    },
    deleted: {
      id: "btree-deleted",
      rank: 40,
      status: "btree-deleted-status",
      title: "Btree Deleted",
    },
  },
  {
    name: "hash",
    scan: (db, key) => scanByStatus(db, key as string),
    oldKey: "hash-original-status",
    newKey: "hash-updated-status",
    insertedKey: "hash-inserted-status",
    deletedKey: "hash-deleted-status",
    original: {
      id: "hash-original",
      rank: 110,
      status: "hash-original-status",
      title: "Hash Original",
    },
    updated: {
      id: "hash-original",
      rank: 120,
      status: "hash-updated-status",
      title: "Hash Updated",
    },
    inserted: {
      id: "hash-inserted",
      rank: 130,
      status: "hash-inserted-status",
      title: "Hash Inserted",
    },
    deleted: {
      id: "hash-deleted",
      rank: 140,
      status: "hash-deleted-status",
      title: "Hash Deleted",
    },
  },
];

describe("BptreeInmemDriver B+ tree forked transactions", () => {
  it("keeps forked B+ tree writes tx-local until rollback or commit", () => {
    const driver = createDriver();

    const rolledBack = {
      id: "task-rollback",
      rank: 10,
      status: "rollback",
      title: "Rollback",
    };
    const rollbackTx = execSync(driver.beginTx());

    execSync(rollbackTx.insert(forkedTxTable.tableName, [rolledBack]));

    expect(scanByRank(rollbackTx, rolledBack.rank)).toEqual([rolledBack]);

    execSync(rollbackTx.rollback());

    expect(scanByRank(driver, rolledBack.rank)).toEqual([]);

    const committed = {
      id: "task-commit",
      rank: 20,
      status: "commit",
      title: "Commit",
    };
    const commitTx = execSync(driver.beginTx());

    execSync(commitTx.insert(forkedTxTable.tableName, [committed]));

    expect(scanByRank(commitTx, committed.rank)).toEqual([committed]);

    execSync(commitTx.commit());

    expect(scanByRank(driver, committed.rank)).toEqual([committed]);
    expect(() => execSync(commitTx.commit())).toThrow(
      "Cannot modify a committed tx",
    );
  });

  it.each(indexCases)(
    "allows outside $name intervalScan during an active transaction",
    ({ scan, oldKey, newKey, original, updated }) => {
      const driver = createDriver([original]);
      const tx = execSync(driver.beginTx());

      execSync(tx.upsert(forkedTxTable.tableName, [updated]));

      expect(scan(tx, oldKey)).toEqual([]);
      expect(scan(tx, newKey)).toEqual([updated]);
      expect(scan(driver, oldKey)).toEqual([original]);
      expect(scan(driver, newKey)).toEqual([]);

      execSync(tx.rollback());
    },
  );

  it("keeps overlapping writes, beginTx, and loadTables blocked", () => {
    const original = indexCases[0].original;
    const updated = indexCases[0].updated;
    const driver = createDriver([original]);
    const tx = execSync(driver.beginTx());

    expect(() => execSync(driver.beginTx())).toThrow(
      "can't run while transaction is in progress",
    );
    expect(() => execSync(driver.loadTables([forkedTxTable]))).toThrow(
      "can't run while transaction is in progress",
    );
    expect(() =>
      execSync(
        driver.insert(forkedTxTable.tableName, [indexCases[0].inserted]),
      ),
    ).toThrow("can't run while transaction is in progress");
    expect(() =>
      execSync(driver.upsert(forkedTxTable.tableName, [updated])),
    ).toThrow("can't run while transaction is in progress");
    expect(() =>
      execSync(driver.delete(forkedTxTable.tableName, [original.id])),
    ).toThrow("can't run while transaction is in progress");

    execSync(tx.rollback());
  });

  it.each(indexCases)(
    "keeps tx inserts invisible to outside $name scans until commit",
    ({ scan, insertedKey, inserted }) => {
      const driver = createDriver();
      const tx = execSync(driver.beginTx());

      execSync(tx.insert(forkedTxTable.tableName, [inserted]));

      expect(scan(tx, insertedKey)).toEqual([inserted]);
      expect(scan(driver, insertedKey)).toEqual([]);

      execSync(tx.commit());

      expect(scan(driver, insertedKey)).toEqual([inserted]);
    },
  );

  it.each(indexCases)(
    "keeps tx upserts invisible to outside $name scans until commit",
    ({ scan, oldKey, newKey, original, updated }) => {
      const driver = createDriver([original]);
      const tx = execSync(driver.beginTx());

      execSync(tx.upsert(forkedTxTable.tableName, [updated]));

      expect(scan(tx, oldKey)).toEqual([]);
      expect(scan(tx, newKey)).toEqual([updated]);
      expect(scan(driver, oldKey)).toEqual([original]);
      expect(scan(driver, newKey)).toEqual([]);

      execSync(tx.commit());

      expect(scan(driver, oldKey)).toEqual([]);
      expect(scan(driver, newKey)).toEqual([updated]);
    },
  );

  it.each(indexCases)(
    "keeps tx deletes invisible to outside $name scans until commit",
    ({ scan, oldKey, original }) => {
      const driver = createDriver([original]);
      const tx = execSync(driver.beginTx());

      execSync(tx.delete(forkedTxTable.tableName, [original.id]));

      expect(scan(tx, oldKey)).toEqual([]);
      expect(scan(driver, oldKey)).toEqual([original]);

      execSync(tx.commit());

      expect(scan(driver, oldKey)).toEqual([]);
    },
  );

  it.each(indexCases)(
    "keeps original committed $name state after rollback",
    ({
      scan,
      oldKey,
      newKey,
      insertedKey,
      deletedKey,
      original,
      updated,
      inserted,
      deleted,
    }) => {
      const driver = createDriver([original, deleted]);
      const tx = execSync(driver.beginTx());

      execSync(tx.insert(forkedTxTable.tableName, [inserted]));
      execSync(tx.upsert(forkedTxTable.tableName, [updated]));
      execSync(tx.delete(forkedTxTable.tableName, [deleted.id]));

      expect(scan(driver, oldKey)).toEqual([original]);
      expect(scan(driver, newKey)).toEqual([]);

      execSync(tx.rollback());

      expect(scan(driver, oldKey)).toEqual([original]);
      expect(scan(driver, newKey)).toEqual([]);
      expect(scan(driver, insertedKey)).toEqual([]);
      expect(scan(driver, deletedKey)).toEqual([deleted]);
    },
  );
});
