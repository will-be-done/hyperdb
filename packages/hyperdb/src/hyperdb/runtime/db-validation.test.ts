/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { DB } from "./db";
import { execSync } from "../core/executor";
import type { DBDriver, DBDriverTX } from "../core/driver";
import type { Row, SelectOptions, WhereClause } from "../core/primitives";
import type { DBCmd } from "../commands/async";
import { defineTable, type TableDefinition } from "../schema/table";
import { v } from "../schema/values";
import { insert as actionInsert, syncDispatch } from "../commands/action/builders";
import { AsyncDB } from "../test-utils/async-db";
import { createDriverFactories } from "../test-utils/driver-factories";

class RecordingDriver implements DBDriver, DBDriverTX {
  inserted: Row[][] = [];
  upserted: Row[][] = [];
  scanRows: unknown[] = [];

  *loadTables(_tables: TableDefinition<any, any>[]): Generator<DBCmd, void> {}

  *beginTx(): Generator<DBCmd, DBDriverTX> {
    return this;
  }

  *intervalScan(
    _table: string,
    _indexName: string,
    _clauses: WhereClause[],
    _selectOptions: SelectOptions,
  ): Generator<DBCmd, unknown[]> {
    return this.scanRows;
  }

  *insert(_tableName: string, values: Row[]): Generator<DBCmd, void> {
    this.inserted.push(values);
  }

  *upsert(_tableName: string, values: Row[]): Generator<DBCmd, void> {
    this.upserted.push(values);
  }

  *delete(_tableName: string, _values: string[]): Generator<DBCmd, void> {}

  *commit(): Generator<DBCmd, void> {}

  *rollback(): Generator<DBCmd, void> {}
}

const docsTable = defineTable("docs", {
  id: v.string(),
  title: v.string(),
  optionalNote: v.optional(v.string()),
  payload: v.any(),
}).index("byTitle", ["title"]);

const scanAll = [
  {
    eq: [{ col: "title", val: "hello" }],
  },
];

describe("DB runtime validation and codec boundary", () => {
  it("validates writes before the driver sees them when runtime validation is enabled", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: true });

    expect(() =>
      execSync(
        db.insert(docsTable, [
          {
            id: "doc-1",
            title: 123,
            payload: null,
          } as any,
        ]),
      ),
    ).toThrow(/Table docs record doc-1: expected string at title/);

    expect(driver.inserted).toEqual([]);
  });

  it("rejects unknown table fields when runtime validation is enabled", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: true });

    expect(() =>
      execSync(
        db.insert(docsTable, [
          {
            id: "doc-1",
            title: "hello",
            payload: null,
            extra: "nope",
          } as any,
        ]),
      ),
    ).toThrow(/Table docs record doc-1: unexpected object field extra at extra/);

    expect(driver.inserted).toEqual([]);
  });

  it("freezes insert and upsert rows when enabled", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { freezeRows: true });
    const inserted = {
      id: "doc-1",
      title: "hello",
      payload: { nested: ["a"] },
    };
    const upserted = {
      id: "doc-2",
      title: "updated",
      payload: { nested: ["b"] },
    };

    execSync(db.insert(docsTable, [inserted]));
    execSync(db.upsert(docsTable, [upserted]));

    expect(Object.isFrozen(inserted)).toBe(true);
    expect(Object.isFrozen(inserted.payload)).toBe(true);
    expect(Object.isFrozen(inserted.payload.nested)).toBe(true);
    expect(Object.isFrozen(upserted)).toBe(true);
    expect(Object.isFrozen(upserted.payload)).toBe(true);
    expect(Object.isFrozen(upserted.payload.nested)).toBe(true);

    const storedInsert = driver.inserted[0][0] as typeof inserted;
    const storedUpsert = driver.upserted[0][0] as typeof upserted;
    expect(Object.isFrozen(storedInsert)).toBe(true);
    expect(Object.isFrozen(storedInsert.payload)).toBe(true);
    expect(Object.isFrozen(storedInsert.payload.nested)).toBe(true);
    expect(Object.isFrozen(storedUpsert)).toBe(true);
    expect(Object.isFrozen(storedUpsert.payload)).toBe(true);
    expect(Object.isFrozen(storedUpsert.payload.nested)).toBe(true);
  });

  it("skips schema validation when disabled while preserving codec normalization", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: false });

    execSync(
      db.insert(docsTable, [
        {
          id: "doc-1",
          title: 123,
          optionalNote: undefined,
          payload: null,
        } as any,
      ]),
    );

    expect(driver.inserted).toEqual([
      [
        {
          id: "doc-1",
          title: 123,
          payload: null,
        },
      ],
    ]);
  });

  it("passes v.pass fields through when runtime validation is disabled", () => {
    const passTable = defineTable("passDocs", {
      id: v.string(),
      payload: v.pass<{ fn: () => string }>(),
    });
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: false });
    const payload = { fn: () => "ok" };

    execSync(db.insert(passTable, [{ id: "doc-1", payload }]));

    expect(driver.inserted[0]?.[0]?.payload).toBe(payload);
  });

  it("strips unknown table fields when runtime validation is disabled", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: false });

    execSync(
      db.insert(docsTable, [
        {
          id: "doc-1",
          title: 123,
          payload: null,
          extra: "nope",
        } as any,
      ]),
    );

    expect(() =>
      execSync(
        db.insert(docsTable, [
          {
            id: "doc-2",
            payload: null,
          } as any,
        ]),
      ),
    ).toThrow(/Table docs record doc-2: missing required field at title/);

    expect(driver.inserted).toEqual([
      [
        {
          id: "doc-1",
          title: 123,
          payload: null,
        },
      ],
    ]);
  });

  it("rejects invalid codec values even when schema validation is disabled", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: false });

    expect(() =>
      execSync(
        db.insert(docsTable, [
          {
            id: "doc-1",
            title: "hello",
            payload: ["ok", undefined],
          } as any,
        ]),
      ),
    ).toThrow(/undefined is not a valid stored value at payload\[1\]/);

    expect(driver.inserted).toEqual([]);
  });

  it("validates records after driver reads when runtime validation is enabled", () => {
    const driver = new RecordingDriver();
    driver.scanRows = [{ id: "doc-1", title: 123, payload: null }];
    const db = new DB(driver, { runtimeValidation: true });

    expect(() => execSync(db.intervalScan(docsTable, "byTitle", scanAll))).toThrow(
      /Table docs record doc-1: expected string at title/,
    );
  });

  it("passes normalized logical records through the driver boundary", () => {
    const driver = new RecordingDriver();
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = new Uint8Array([4, 5]).buffer;
    const db = new DB(driver, { runtimeValidation: true });

    execSync(
      db.insert(docsTable, [
        {
          id: "doc-1",
          title: "hello",
          payload: {
            count: 10n,
            bytes,
            buffer,
          },
        },
      ]),
    );
    driver.scanRows = driver.inserted[0];

    expect(driver.inserted[0][0].payload).toEqual({
      count: 10n,
      bytes,
      buffer,
    });

    const [record] = execSync(db.intervalScan(docsTable, "byTitle", scanAll));

    expect(record.payload.count).toBe(10n);
    expect(record.payload.bytes).toEqual(bytes);
    expect(new Uint8Array(record.payload.buffer)).toEqual(
      new Uint8Array(buffer),
    );
  });

  it("applies write validation through transactions", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: true });
    const tx = execSync(db.beginTx());

    expect(() =>
      execSync(
        tx.upsert(docsTable, [
          {
            id: "doc-1",
            title: "hello",
            optionalNote: 123,
            payload: null,
          } as any,
        ]),
      ),
    ).toThrow(/Table docs record doc-1: expected string at optionalNote/);

    expect(driver.upserted).toEqual([]);
    execSync(tx.rollback());
  });

  it("applies write validation through action dispatch", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: true });

    function* writeInvalidDoc() {
      yield* actionInsert(docsTable, [
        {
          id: "doc-1",
          title: false,
          payload: null,
        } as any,
      ]);
    }

    expect(() => syncDispatch(db, writeInvalidDoc())).toThrow(
      /Table docs record doc-1: expected string at title/,
    );
    expect(driver.inserted).toEqual([]);
  });


  it("treats empty write batches as no-ops", () => {
    const driver = new RecordingDriver();
    const db = new DB(driver, { runtimeValidation: true });

    execSync(db.insert(docsTable, []));
    execSync(db.upsert(docsTable, []));

    expect(driver.inserted).toEqual([]);
    expect(driver.upserted).toEqual([]);
  });

  for (const [name, driverFactory] of createDriverFactories()) {
    it(`round-trips rich document values through ${name}`, async () => {
      const driver = await driverFactory();
      const db = new AsyncDB(new DB(driver, { runtimeValidation: true }));
      await db.loadTables([docsTable]);

      const bytes = new Uint8Array([8, 9, 10]);
      const buffer = new Uint8Array([11, 12]).buffer;

      await db.insert(docsTable, [
        {
          id: "doc-1",
          title: "hello",
          payload: {
            big: 9007199254740993n,
            bytes,
            buffer,
          },
        },
      ]);

      const [record] = await db.intervalScan(docsTable, "byTitle", scanAll);

      expect(record.payload.big).toBe(9007199254740993n);
      expect(record.payload.bytes).toEqual(bytes);
      expect(new Uint8Array(record.payload.buffer)).toEqual(
        new Uint8Array(buffer),
      );
    });
  }
});
