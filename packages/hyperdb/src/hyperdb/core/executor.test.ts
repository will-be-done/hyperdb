import { describe, expect, it } from "vitest";
import { noop, unwrap, type DBCmd } from "../commands/async";
import { execAsync, execMaybeAsync, execSync } from "./executor";

function* unexpectedCommand(): Generator<DBCmd, void> {
  yield { type: "unexpected" } as unknown as DBCmd;
}

describe("executor", () => {
  it("throws when execSync receives an unexpected command", () => {
    expect(() => execSync(unexpectedCommand())).toThrow(
      /Unexpected DBCmd yielded/,
    );
  });

  it("throws when execAsync receives an unexpected command", async () => {
    await expect(execAsync(unexpectedCommand())).rejects.toThrow(
      /Unexpected DBCmd yielded/,
    );
  });

  it("throws when execSync receives an unwrap command, including rejected promises", () => {
    const rejection = Promise.reject(new Error("boom"));
    rejection.catch(() => undefined);

    function* command(): Generator<DBCmd, void> {
      yield* unwrap(rejection);
    }

    expect(() => execSync(command())).toThrow("Cannot execute async commands");
  });

  it("rejects look-alike commands without the brand", () => {
    function* command(): Generator<DBCmd, void> {
      yield { type: "noop" } as unknown as DBCmd;
    }

    expect(() => execSync(command())).toThrow(/Unexpected DBCmd yielded/);
  });

  it("throws async commands back into generators in execSync so cleanup runs", () => {
    const steps: string[] = [];

    function* command(): Generator<DBCmd, void, unknown> {
      try {
        yield* unwrap(Promise.resolve("never awaited"));
        steps.push("continued");
      } finally {
        steps.push("cleaned up");
        yield* noop();
      }
    }

    expect(() => execSync(command())).toThrow(
      expect.objectContaining({ code: "ASYNC_IN_SYNC_EXECUTION" }),
    );
    expect(steps).toEqual(["cleaned up"]);
  });

  it("observes the promise execSync abandons so its rejection is handled", async () => {
    function* command(): Generator<DBCmd, void, unknown> {
      // No manual .catch(): execSync must observe it, or Vitest reports an
      // unhandled rejection once the promise rejects.
      yield* unwrap(Promise.reject(new Error("late cleanup failure")));
    }

    expect(() => execSync(command())).toThrow("Cannot execute async commands");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("propagates errors rejected by async unwrap commands", async () => {
    function* command(): Generator<DBCmd, void, unknown> {
      yield* unwrap(Promise.reject(new Error("boom")));
    }

    await expect(execAsync(command())).rejects.toThrow("boom");
  });

  it("throws rejected async commands back into generators", async () => {
    let cleanedUp = false;

    function* command(): Generator<DBCmd, void, unknown> {
      try {
        yield* unwrap(Promise.reject(new Error("boom")));
      } finally {
        cleanedUp = true;
      }
    }

    await expect(execAsync(command())).rejects.toThrow("boom");
    expect(cleanedUp).toBe(true);
  });

  it("throws rejected execMaybeAsync commands back into generators", async () => {
    let cleanedUp = false;

    function* command(): Generator<DBCmd, void, unknown> {
      try {
        yield* unwrap(Promise.reject(new Error("boom")));
      } finally {
        cleanedUp = true;
      }
    }

    await expect(execMaybeAsync(command())).rejects.toThrow("boom");
    expect(cleanedUp).toBe(true);
  });

  it("continues through noop commands in execSync", () => {
    function* command(): Generator<DBCmd, string> {
      yield* noop();
      return "done";
    }

    expect(execSync(command())).toBe("done");
  });

  it("continues through noop commands in execAsync", async () => {
    function* command(): Generator<DBCmd, string> {
      yield* noop();
      return "done";
    }

    await expect(execAsync(command())).resolves.toBe("done");
  });

  it("resolves async unwrap command values", async () => {
    function* command(): Generator<DBCmd, string, string> {
      const value = yield* unwrap(Promise.resolve("done"));
      return value;
    }

    await expect(execAsync(command())).resolves.toBe("done");
  });

  it("returns synchronously from execMaybeAsync when no async command is yielded", () => {
    function* command(): Generator<DBCmd, string> {
      yield* noop();
      return "done";
    }

    expect(execMaybeAsync(command())).toBe("done");
  });

  it("continues execMaybeAsync asynchronously from the first async command", async () => {
    const steps: string[] = [];

    function* command(): Generator<DBCmd, string, string> {
      steps.push("start");
      const value = yield* unwrap(Promise.resolve("async"));
      steps.push(value);
      return "done";
    }

    const result = execMaybeAsync(command());

    expect(result).toBeInstanceOf(Promise);
    expect(steps).toEqual(["start"]);
    await expect(result).resolves.toBe("done");
    expect(steps).toEqual(["start", "async"]);
  });
});
