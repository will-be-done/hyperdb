import { describe, expect, it } from "vitest";
import { defineAnnotation } from "./annotations";
import { defineTable } from "./table";
import { assertValid, v } from "./values";

const hidden = defineAnnotation("test.hidden");
const label = defineAnnotation("test.label", (text: string) => ({ text }));

describe("annotations", () => {
  it("reads column annotations, including through optional, as copies", () => {
    const shared = v.string();
    const table = defineTable("annotated", {
      id: v.string(),
      title: shared.with(hidden(), label("first"), label("Title")),
      note: v.optional(v.string().with(hidden())).with(label("Note")),
      plain: shared,
      constructor: v.number().with(hidden()),
    });

    expect(shared.annotations).toEqual([]);
    expect(assertValid(shared.with(hidden()), "ok")).toBe("ok");
    expect(hidden.fields(table)).toEqual(["title", "note", "constructor"]);
    expect(label.columns(table)).toEqual([
      { field: "title", value: { text: "Title" } },
      { field: "note", value: { text: "Note" } },
    ]);
    expect(label.of(table)).toBeUndefined();
  });

  it("keeps table annotations and indexes across with() and index()", () => {
    const base = defineTable("annotatedTable", {
      id: v.string(),
      n: v.number(),
    });
    const table = base.with(label("table")).index("byN", ["n"]);

    expect(label.of(table)).toEqual({ text: "table" });
    expect(label.of(base)).toBeUndefined();
    expect(Object.keys(table.with(hidden()).indexes)).toEqual(["byId", "byN"]);
    expect(hidden.of(table.with(hidden()))).toBe(true);
  });

  it("collects column annotations from every union variant", () => {
    const table = defineTable(
      "annotatedUnion",
      v.union(
        v.object({
          id: v.string(),
          kind: v.literal("a"),
          body: v.string().with(label("First")),
        }),
        v.object({
          id: v.string(),
          kind: v.literal("b"),
          body: v.string().with(hidden()),
        }),
      ),
    );

    expect(hidden.fields(table)).toEqual(["body"]);
    expect(label.fields(table)).toEqual(["body"]);
  });

  it("keeps annotations through v.partial and v.required", () => {
    const object = v
      .object({ id: v.string(), note: v.optional(v.string()).with(hidden()) })
      .with(label("object"));
    const required = v.required(object, ["note"]);

    expect(v.partial(object).annotations).toEqual(object.annotations);
    expect(required.annotations).toEqual(object.annotations);
    expect(hidden.fields(defineTable("required", required.fields))).toEqual([
      "note",
    ]);
  });
});
