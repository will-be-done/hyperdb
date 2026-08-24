import { describe, expect, it } from "vitest";
import { HashIndex } from "./hash-index";

describe("HashIndex", () => {
  it("stores arbitrary leaf values and enforces uniqueness", () => {
    const index = new HashIndex<string>({ name: "bySlug", unique: true });
    index.insert([{ key: "first", id: "1", value: "1" }]);

    expect(index.scan(["first"])).toEqual(["1"]);
    expect(() => index.upsert([{ key: "first", id: "2", value: "2" }])).toThrow(
      "Unique hash index bySlug already has value for record 1",
    );
  });

  it("supports non-unique buckets", () => {
    const index = new HashIndex<string>({ name: "byTitle", unique: false });
    index.insert([
      { key: "same", id: "1", value: "1" },
      { key: "same", id: "2", value: "2" },
    ]);

    expect(index.scan(["same"])).toEqual(["1", "2"]);
  });

  it("commits and rolls back copy-on-write transactions", () => {
    const index = new HashIndex<{ id: string; value: number }>({
      name: "byId",
      unique: true,
    });
    index.insert([{ key: "1", id: "1", value: { id: "1", value: 1 } }]);

    const rollback = index.tx();
    rollback.upsert([{ key: "1", id: "1", value: { id: "1", value: 2 } }]);
    expect(rollback.scan(["1"])).toEqual([{ id: "1", value: 2 }]);
    rollback.rollback();
    expect(index.scan(["1"])).toEqual([{ id: "1", value: 1 }]);

    const commit = index.tx();
    commit.upsert([{ key: "1", id: "1", value: { id: "1", value: 3 } }]);
    expect(commit.commit()).toBe(index);
    expect(index.scan(["1"])).toEqual([{ id: "1", value: 3 }]);
  });

  it("supports swapping unique keys in one upsert", () => {
    const index = new HashIndex<string>({ name: "bySlug", unique: true });
    index.insert([
      { key: "first", id: "1", value: "1" },
      { key: "second", id: "2", value: "2" },
    ]);

    index.upsert([
      { key: "second", id: "1", value: "1" },
      { key: "first", id: "2", value: "2" },
    ]);

    expect(index.scan(["first"])).toEqual(["2"]);
    expect(index.scan(["second"])).toEqual(["1"]);
  });
});
