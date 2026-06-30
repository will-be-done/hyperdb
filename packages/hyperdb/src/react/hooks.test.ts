import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setHyperDBHookDepsForTest,
  useAsyncSelector,
  useSyncSelector,
} from "./hooks";

type Subscriber = (ops: unknown[]) => void;
type MockDB = {
  subscribe: (cb: Subscriber) => () => void;
  emit(ops: unknown[]): void;
  subscriberCount(): number;
};

const mocks = {
  cleanup: undefined as undefined | (() => void),
  db: undefined as unknown as MockDB,
  refs: [] as { current: unknown }[],
  setState: vi.fn(),
  initCachedSelector: vi.fn(),
  runCachedSelectorMaybeAsync: vi.fn(),
  runSelectorAsync: vi.fn(),
  runSelectorMaybeAsync: vi.fn(),
  isNeedToRerunRange: vi.fn(),
  stableSerializeSelectorArgs: vi.fn(),
};

const fakeReactHooks = {
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
  useState: vi.fn((initial) => [
    typeof initial === "function" ? initial() : initial,
    mocks.setState,
  ]),
  useSyncExternalStore: vi.fn((_subscribe, getSnapshot) => getSnapshot()),
};

let restoreHookDeps: (() => void) | undefined;

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

function createMockSelectorStore<T>(initial: T, refreshed: T[] = []) {
  let snapshot = initial;

  return {
    getSnapshot: vi.fn(() => snapshot),
    refresh: vi.fn(() => {
      const next = refreshed.shift();
      if (next !== undefined) {
        snapshot = next;
      }
    }),
    setSnapshot: vi.fn((value: T) => {
      snapshot = value;
    }),
    subscribe: vi.fn(() => vi.fn()),
  };
}

describe("useAsyncSelector", () => {
  beforeEach(() => {
    mocks.cleanup = undefined;
    mocks.db = createMockDB();
    mocks.refs = [];
    mocks.setState.mockReset();
    mocks.initCachedSelector.mockReset();
    mocks.runCachedSelectorMaybeAsync.mockReset();
    mocks.runSelectorAsync.mockReset();
    mocks.runSelectorMaybeAsync.mockReset();
    mocks.isNeedToRerunRange.mockReset();
    mocks.stableSerializeSelectorArgs.mockReset();
    mocks.stableSerializeSelectorArgs.mockReturnValue("args-key");
    restoreHookDeps = setHyperDBHookDepsForTest({
      ...fakeReactHooks,
      useDB: () => mocks.db,
      initCachedSelector: (...args) => mocks.initCachedSelector(...args),
      runCachedSelectorMaybeAsync: (...args) =>
        mocks.runCachedSelectorMaybeAsync(...args),
      runSelectorAsync: (...args) => mocks.runSelectorAsync(...args),
      runSelectorMaybeAsync: (...args) => mocks.runSelectorMaybeAsync(...args),
      isNeedToRerunRange: (...args) => mocks.isNeedToRerunRange(...args),
      stableSerializeSelectorArgs: (...args) =>
        mocks.stableSerializeSelectorArgs(...args),
    });
  });

  afterEach(() => {
    restoreHookDeps?.();
    restoreHookDeps = undefined;
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
    });

    expect(result).toEqual(["task-1"]);
    expect(mocks.initCachedSelector).toHaveBeenCalledWith(mocks.db, selector, {
      projectId: "project-1",
    });
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

    mocks.runSelectorMaybeAsync.mockImplementation(
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

    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).toHaveBeenCalledTimes(1);
    mocks.setState.mockClear();

    mocks.db.emit([{ id: "op-1" }]);
    mocks.db.emit([{ id: "op-2" }]);
    mocks.db.emit([{ id: "op-3" }]);

    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(1);

    first.resolve("stale");
    await flushPromises();

    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(2);

    second.resolve("latest");
    await flushPromises();

    expect(mocks.setState).toHaveBeenCalledTimes(1);
    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "latest",
        status: "success",
      }),
    );
    expect(mocks.refs[2].current).toEqual([secondCmd]);

    const ignoredOps = [{ id: "ignored" }];
    mocks.isNeedToRerunRange.mockReturnValue(false);

    mocks.db.emit(ignoredOps);

    expect(mocks.isNeedToRerunRange).toHaveBeenCalledWith(
      [secondCmd],
      ignoredOps,
    );
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending async selector result after unmount cleanup", async () => {
    const pending = deferred<string>();
    const cmd = { table: "tasks", range: "pending" };

    mocks.runSelectorMaybeAsync.mockImplementation(
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

    const selectRangeCmdsRef = mocks.refs[2];
    expect(mocks.db.subscriberCount()).toBe(1);
    mocks.setState.mockClear();

    mocks.cleanup?.();

    expect(mocks.db.subscriberCount()).toBe(0);

    pending.resolve("late");
    await flushPromises();

    expect(mocks.setState).not.toHaveBeenCalled();
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

    expect(result.data).toEqual([]);
    expect(result.status).toBe("pending");
    expect(result.fetchStatus).toBe("idle");
    expect(result.isEnabled).toBe(false);
    expect(mocks.stableSerializeSelectorArgs).not.toHaveBeenCalled();
    expect(mocks.runSelectorMaybeAsync).not.toHaveBeenCalled();
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("reads HybridDB cache snapshots synchronously while preloading through the async db", async () => {
    const cacheDB = {
      beginTx: vi.fn(),
      intervalScan: vi.fn(),
    };
    mocks.db = {
      ...createMockDB(),
      db: { cache: cacheDB },
    } as unknown as MockDB;
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });
    const cmd = { table: "tasks", range: "hybrid" };
    const selectorStore = createMockSelectorStore(["cached"], [["fresh"]]);

    mocks.initCachedSelector.mockReturnValue(selectorStore);
    mocks.runCachedSelectorMaybeAsync.mockImplementation(
      (_db, _selector, _args, cmds: unknown[]) => {
        cmds.push(cmd);
        selector({ projectId: "project-1" });
        return Promise.resolve(["fresh"]);
      },
    );

    const result = useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(result.data).toEqual(["cached"]);
    expect(result.status).toBe("success");
    expect(result.isLoading).toBe(false);
    expect(result.isRefetching).toBe(true);
    expect(mocks.initCachedSelector).toHaveBeenCalledWith(
      expect.objectContaining({ db: cacheDB }),
      selector,
      { projectId: "project-1" },
    );
    expect(mocks.runCachedSelectorMaybeAsync).toHaveBeenCalledWith(
      mocks.db,
      selector,
      { projectId: "project-1" },
      expect.any(Array),
    );
    expect(mocks.runSelectorMaybeAsync).not.toHaveBeenCalled();

    await flushPromises();

    expect(selectorStore.refresh).not.toHaveBeenCalled();
    expect(selectorStore.setSnapshot).toHaveBeenCalledWith(["fresh"]);
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["fresh"],
        status: "success",
      }),
    );
  });

  it("does not refresh the HybridDB cache snapshot until preload finishes", async () => {
    const cacheDB = {
      beginTx: vi.fn(),
      intervalScan: vi.fn(),
    };
    mocks.db = {
      ...createMockDB(),
      db: { cache: cacheDB },
    } as unknown as MockDB;
    const pending = deferred<string[]>();
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });
    const selectorStore = createMockSelectorStore(["cached"], [["fresh"]]);

    mocks.initCachedSelector.mockReturnValue(selectorStore);
    mocks.runCachedSelectorMaybeAsync.mockImplementation(
      (_db, _selector, _args, _cmds: unknown[]) => {
        selector({ projectId: "project-1" });
        return pending.promise;
      },
    );

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(selectorStore.setSnapshot).not.toHaveBeenCalled();

    await flushPromises();
    expect(selectorStore.setSnapshot).not.toHaveBeenCalled();

    pending.resolve(["fresh"]);
    await flushPromises();

    expect(selectorStore.refresh).not.toHaveBeenCalled();
    expect(selectorStore.setSnapshot).toHaveBeenCalledWith(["fresh"]);
  });

  it("ignores a late HybridDB preload after args change cleanup", async () => {
    const cacheDB = {
      beginTx: vi.fn(),
      intervalScan: vi.fn(),
    };
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const firstStore = createMockSelectorStore(["cached-1"], [["fresh-1"]]);
    const secondStore = createMockSelectorStore(["cached-2"], [["fresh-2"]]);

    mocks.initCachedSelector
      .mockReturnValueOnce(firstStore)
      .mockReturnValueOnce(secondStore);
    mocks.runCachedSelectorMaybeAsync
      .mockImplementationOnce((_db, _selector, _args, _cmds: unknown[]) => {
        return first.promise;
      })
      .mockImplementationOnce((_db, _selector, _args, _cmds: unknown[]) => {
        return second.promise;
      });
    mocks.stableSerializeSelectorArgs
      .mockReturnValueOnce("project-1")
      .mockReturnValueOnce("project-2");
    mocks.db = {
      ...createMockDB(),
      db: { cache: cacheDB },
    } as unknown as MockDB;

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });
    const firstCleanup = mocks.cleanup;

    firstCleanup?.();
    useAsyncSelector({
      selector,
      args: { projectId: "project-2" },
      defaultValue: [],
    });

    expect(mocks.initCachedSelector).toHaveBeenCalledTimes(2);

    first.resolve(["stale-1"]);
    await flushPromises();

    expect(firstStore.setSnapshot).not.toHaveBeenCalled();
    expect(secondStore.setSnapshot).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["stale-1"],
      }),
    );

    second.resolve(["fresh-2"]);
    await flushPromises();

    expect(firstStore.setSnapshot).not.toHaveBeenCalled();
    expect(secondStore.refresh).not.toHaveBeenCalled();
    expect(secondStore.setSnapshot).toHaveBeenCalledWith(["fresh-2"]);
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["fresh-2"],
        status: "success",
      }),
    );
  });

  it("reuses the same HybridDB cache wrapper across selector args", () => {
    const cacheDB = {
      beginTx: vi.fn(),
      intervalScan: vi.fn(),
    };
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.initCachedSelector.mockReturnValue(
      createMockSelectorStore(["cached"]),
    );
    mocks.runCachedSelectorMaybeAsync.mockReturnValue(new Promise(() => {}));
    mocks.stableSerializeSelectorArgs
      .mockReturnValueOnce("project-1")
      .mockReturnValueOnce("project-2")
      .mockReturnValueOnce("project-1");
    mocks.db = {
      ...createMockDB(),
      db: { cache: cacheDB },
    } as unknown as MockDB;

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });
    mocks.cleanup?.();
    useAsyncSelector({
      selector,
      args: { projectId: "project-2" },
      defaultValue: [],
    });
    mocks.cleanup?.();
    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(mocks.initCachedSelector).toHaveBeenCalledTimes(3);
    expect(mocks.initCachedSelector.mock.calls[0]?.[0]).toBe(
      mocks.initCachedSelector.mock.calls[2]?.[0],
    );
    expect(mocks.initCachedSelector.mock.calls[0]?.[2]).toEqual({
      projectId: "project-1",
    });
    expect(mocks.initCachedSelector.mock.calls[2]?.[2]).toEqual({
      projectId: "project-1",
    });
  });

  it("resolves refetch with the freshly fetched selector result", async () => {
    const pending = deferred<string[]>();
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });
    mocks.runSelectorMaybeAsync.mockReturnValue(pending.promise);

    const result = useAsyncSelector({
      selector,
      args: {},
      initialData: ["stale"],
      subscribed: false,
    });

    const refetchPromise = result.refetch();
    pending.resolve(["fresh"]);
    await flushPromises();
    const refetchResult = await refetchPromise;

    expect(refetchResult.data).toEqual(["fresh"]);
    expect(refetchResult.status).toBe("success");
    expect(refetchResult.isSuccess).toBe(true);
    expect(refetchResult.isFetching).toBe(false);
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("applies fully synchronous async selector runs without waiting for a promise turn", () => {
    const cmd = { table: "tasks", range: "sync" };
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.runSelectorMaybeAsync.mockImplementation(
      (_db, gen, cmds: unknown[]) => {
        cmds.push(cmd);
        gen();
        return ["task-1"];
      },
    );

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(selector).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.runSelectorAsync).not.toHaveBeenCalled();
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["task-1"],
        status: "success",
      }),
    );
    expect(mocks.refs[2].current).toEqual([cmd]);
  });

  it("runs object-form async selectors with args", async () => {
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.runSelectorMaybeAsync.mockImplementation((_db, gen) => {
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
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["task-1"],
        status: "success",
      }),
    );
  });

  it("resets object-form async selector result when args key changes", () => {
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });
    mocks.runSelectorMaybeAsync.mockReturnValue(new Promise(() => {}));
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

    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({ data: ["loading-1"] }),
    );
    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({ data: ["loading-2"] }),
    );
    expect(mocks.runSelectorMaybeAsync).toHaveBeenCalledTimes(2);
  });
});
