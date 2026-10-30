import { describe, expect, it } from "vitest";
import { equalValues } from "./values";

describe("undo value equality", () => {
  it.each([
    [new Uint8Array([255]), new Int8Array([-1])],
    [new Uint16Array([1]), new Uint8Array(new Uint16Array([1]).buffer)],
    [new DataView(new Uint8Array([1]).buffer), new Uint8Array([1])],
    [new Uint8Array([1]).buffer, new Uint8Array([1])],
  ])("distinguishes binary constructors for matching bytes (%#)", (a, b) => {
    expect(equalValues({ data: a }, { data: b })).toBe(false);
    expect(equalValues({ data: b }, { data: a })).toBe(false);
  });

  it("compares matching binary types by their view contents", () => {
    const buffer = new Uint8Array([9, 1, 2, 9]).buffer;
    expect(
      equalValues(new Uint8Array(buffer, 1, 2), new Uint8Array([1, 2])),
    ).toBe(true);
    expect(
      equalValues(
        new DataView(buffer, 1, 2),
        new DataView(new Uint8Array([1, 2]).buffer),
      ),
    ).toBe(true);
    expect(equalValues(buffer.slice(1, 3), new Uint8Array([1, 2]).buffer)).toBe(
      true,
    );
    expect(equalValues(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(equalValues(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(
      false,
    );
  });
});
