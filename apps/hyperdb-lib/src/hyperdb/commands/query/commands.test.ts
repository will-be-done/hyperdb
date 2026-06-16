import { describe, expect, test } from "vitest";
import { isRunSelectorCmd, isSelectRangeCmd } from "./commands";

describe("isRunSelectorCmd", () => {
  test("accepts a well-formed runSelector marker", () => {
    const marker = {
      type: "runSelector",
      selector: {},
      args: { id: "1" },
      makeBody: function* () {},
      name: "mySelector",
    };

    expect(isRunSelectorCmd(marker)).toBe(true);
  });

  test("rejects other command shapes and non-objects", () => {
    expect(isRunSelectorCmd({ type: "selectRange" })).toBe(false);
    expect(isRunSelectorCmd({ type: "noop" })).toBe(false);
    expect(isRunSelectorCmd({})).toBe(false);
    expect(isRunSelectorCmd(null)).toBe(false);
    expect(isRunSelectorCmd(undefined)).toBe(false);
    expect(isRunSelectorCmd("runSelector")).toBe(false);
    expect(isRunSelectorCmd(42)).toBe(false);
  });

  test("does not confuse a select-range cmd with a run-selector cmd", () => {
    const selectRange = { type: "selectRange" };

    expect(isSelectRangeCmd(selectRange)).toBe(true);
    expect(isRunSelectorCmd(selectRange)).toBe(false);
  });
});
