import { beforeEach, describe, expect, it, vi } from "vitest";

type Subscriber = (ops: unknown[]) => void;
type MockDB = {
  subscribe: (cb: Subscriber) => () => void;
  emit(ops: unknown[]): void;
  subscriberCount(): number;
};

const mocks = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  db: undefined as unknown as MockDB,
  refs: [] as { current: unknown }[],
  setResult: vi.fn(),
  initCachedSelector: vi.fn(),
  runSelectorAsync: vi.fn(),
  isNeedToRerunRange: vi.fn(),
  stableSerializeSelectorArgs: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: vi.fn((cb) => cb),
  useEffect: vi.fn((effect) => {
    mocks.cleanup = effect();
  }),
  useMemo: vi.fn((factory) => factory()),
  useRef: vi.fn((initial) => {
    const ref = { current: initial };
    mocks.refs.push(ref);
    return ref;
  }),
  useState: vi.fn((initial) => [initial, mocks.setResult]),
  useSyncExternalStore: vi.fn((_subscribe, getSnapshot) => getSnapshot()),
}));

vi.mock("./context", () => ({
  useDB: () => mocks.db,
}));

vi.mock("../hyperdb/commands/query/selector", () => ({
  initCachedSelector: (...args: unknown[]) =>
    mocks.initCachedSelector(...args),
  initSelector: vi.fn(),
  isNeedToRerunRange: (...args: unknown[]) =>
    mocks.isNeedToRerunRange(...args),
  runSelectorAsync: (...args: unknown[]) => mocks.runSelectorAsync(...args),
  select: vi.fn(),
  stableSerializeSelectorArgs: (...args: unknown[]) =>
    mocks.stableSerializeSelectorArgs(...args),
}));

import { useAsyncSelector, useSyncSelector } from "./hooks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function createMockDB() {
  const subscribers: Subscriber[] = [];

  return {
    subscribe: vi.fn((cb: Subscriber) => {
      subscribers.push(cb);

      return () => {
        const index = subscribers.indexOf(cb);
        if (index !== -1) {
          subscribers.splice(index, 1);
        }
      };
    }),
    emit(ops: unknown[]) {
      for (const subscriber of [...subscribers]) {
        subscriber(ops);
      }
    },
    subscriberCount() {
      return subscribers.length;
    },
  };
}

describe("useAsyncSelector", () => {
  beforeEach(() => {
    mocks.cleanup = undefined;
    mocks.db = createMockDB();
    mocks.refs = [];
    mocks.setResult.mockReset();
    mocks.initCachedSelector.mockReset();
    mocks.runSelectorAsync.mockReset();
    mocks.isNeedToRerunRange.mockReset();
    mocks.stableSerializeSelectorArgs.mockReset();
    mocks.stableSerializeSelectorArgs.mockReturnValue("args-key");
  });

  it("runs object-form sync selectors through the shared cache", () => {
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });
    const store = {
      subscribe: vi.fn(() => vi.fn()),
      getSnapshot: vi.fn(() => ["task-1"]),
    };
    mocks.initCachedSelector.mockReturnValue(store);

    const result = useSyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
      gcTime: 30_000,
    });

    expect(result).toEqual(["task-1"]);
    expect(mocks.initCachedSelector).toHaveBeenCalledWith(
      mocks.db,
      selector,
      { projectId: "project-1" },
      {
        gcTime: 30_000,
      },
    );
  });

  it("returns default value for disabled sync selectors without creating cache entries", () => {
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });

    const result = useSyncSelector({
      selector,
      args: { projectId: "project-1" },
      enabled: false,
      defaultValue: [],
    });

    expect(result).toEqual([]);
    expect(mocks.stableSerializeSelectorArgs).not.toHaveBeenCalled();
    expect(mocks.initCachedSelector).not.toHaveBeenCalled();
  });

  it("collapses overlapping subscription reruns and applies only the latest async result", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstCmd = { table: "tasks", range: "first" };
    const secondCmd = { table: "tasks", range: "second" };
    let runCount = 0;

    mocks.runSelectorAsync.mockImplementation(
      (_db, _gen, cmds: unknown[]) => {
        runCount++;
        if (runCount === 1) {
          cmds.push(firstCmd);
          return first.promise;
        }

        cmds.push(secondCmd);
        return second.promise;
      },
    );

    useAsyncSelector({
      selector: function* selector() {
        return "unused";
      },
      args: {},
    });

    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).toHaveBeenCalledTimes(1);

    mocks.db.emit([{ id: "op-1" }]);
    mocks.db.emit([{ id: "op-2" }]);
    mocks.db.emit([{ id: "op-3" }]);

    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(1);

    first.resolve("stale");
    await flushPromises();

    expect(mocks.setResult).not.toHaveBeenCalled();
    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(2);

    second.resolve("latest");
    await flushPromises();

    expect(mocks.setResult).toHaveBeenCalledTimes(1);
    expect(mocks.setResult).toHaveBeenCalledWith("latest");
    expect(mocks.refs[0].current).toEqual([secondCmd]);

    const ignoredOps = [{ id: "ignored" }];
    mocks.isNeedToRerunRange.mockReturnValue(false);

    mocks.db.emit(ignoredOps);

    expect(mocks.isNeedToRerunRange).toHaveBeenCalledWith(
      [secondCmd],
      ignoredOps,
    );
    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending async selector result after unmount cleanup", async () => {
    const pending = deferred<string>();
    const cmd = { table: "tasks", range: "pending" };

    mocks.runSelectorAsync.mockImplementation(
      (_db, _gen, cmds: unknown[]) => {
        cmds.push(cmd);
        return pending.promise;
      },
    );

    useAsyncSelector({
      selector: function* selector() {
        return "unused";
      },
      args: {},
    });

    const selectRangeCmdsRef = mocks.refs[0];
    expect(mocks.db.subscriberCount()).toBe(1);

    mocks.cleanup?.();

    expect(mocks.db.subscriberCount()).toBe(0);

    pending.resolve("late");
    await flushPromises();

    expect(mocks.setResult).not.toHaveBeenCalled();
    expect(selectRangeCmdsRef.current).toEqual([]);
  });

  it("returns default value for disabled async selectors without running or subscribing", () => {
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });

    const result = useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      enabled: false,
      defaultValue: [],
    });

    expect(result).toEqual([]);
    expect(mocks.stableSerializeSelectorArgs).not.toHaveBeenCalled();
    expect(mocks.runSelectorAsync).not.toHaveBeenCalled();
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("runs object-form async selectors with args", async () => {
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.runSelectorAsync.mockImplementation((_db, gen) => {
      gen();
      return Promise.resolve(["task-1"]);
    });

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    await flushPromises();

    expect(selector).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.setResult).toHaveBeenCalledWith(["task-1"]);
  });

  it("resets object-form async selector result when args key changes", () => {
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });
    mocks.runSelectorAsync.mockReturnValue(new Promise(() => {}));
    mocks.stableSerializeSelectorArgs
      .mockReturnValueOnce("project-1")
      .mockReturnValueOnce("project-2");

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: ["loading-1"],
    });
    mocks.cleanup?.();
    useAsyncSelector({
      selector,
      args: { projectId: "project-2" },
      defaultValue: ["loading-2"],
    });

    expect(mocks.setResult).toHaveBeenCalledWith(["loading-1"]);
    expect(mocks.setResult).toHaveBeenCalledWith(["loading-2"]);
    expect(mocks.runSelectorAsync).toHaveBeenCalledTimes(2);
  });
});
