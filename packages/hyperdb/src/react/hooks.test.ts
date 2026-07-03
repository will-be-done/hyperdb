import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setHyperDBHookDepsForTest,
  useAsyncSelector,
  useSyncSelector,
} from "./hooks";

type Subscriber = (ops: unknown[], traits: unknown[], revision: number) => void;
type MockDB = {
  subscribe: (cb: Subscriber) => () => void;
  getRevision: () => number;
  emit(ops: unknown[]): void;
  subscriberCount(): number;
};

const mocks = {
  cleanup: undefined as undefined | (() => void),
  db: undefined as unknown as MockDB,
  refs: [] as { current: unknown }[],
  setState: vi.fn(),
  createCachedSelectorStoreSync: vi.fn(),
  selectCachedMaybeAsync: vi.fn(),
  selectAsync: vi.fn(),
  selectMaybeAsync: vi.fn(),
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
  let revision = 0;

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
    getRevision: vi.fn(() => revision),
    emit(ops: unknown[]) {
      revision++;
      for (const subscriber of [...subscribers]) {
        subscriber(ops, [], revision);
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
    mocks.setState.mockReset();
    mocks.createCachedSelectorStoreSync.mockReset();
    mocks.selectCachedMaybeAsync.mockReset();
    mocks.selectAsync.mockReset();
    mocks.selectMaybeAsync.mockReset();
    mocks.isNeedToRerunRange.mockReset();
    mocks.stableSerializeSelectorArgs.mockReset();
    mocks.stableSerializeSelectorArgs.mockReturnValue("args-key");
    restoreHookDeps = setHyperDBHookDepsForTest({
      ...fakeReactHooks,
      useDB: () => mocks.db,
      createCachedSelectorStoreSync: (...args) =>
        mocks.createCachedSelectorStoreSync(...args),
      selectCachedMaybeAsync: (...args) =>
        mocks.selectCachedMaybeAsync(...args),
      selectAsync: (...args) => mocks.selectAsync(...args),
      selectMaybeAsync: (...args) => mocks.selectMaybeAsync(...args),
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
    mocks.createCachedSelectorStoreSync.mockReturnValue(store);

    const result = useSyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(result).toEqual(["task-1"]);
    expect(mocks.createCachedSelectorStoreSync).toHaveBeenCalledWith(mocks.db, {
      selector,
      args: { projectId: "project-1" },
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
    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();
  });

  it("collapses overlapping subscription reruns and applies only the latest async result", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstCmd = { table: "tasks", range: "first" };
    const secondCmd = { table: "tasks", range: "second" };
    let runCount = 0;

    mocks.selectMaybeAsync.mockImplementation((_db, input) => {
      const cmds = input.selectRangeCmds;
      runCount++;
      if (runCount === 1) {
        cmds.push(firstCmd);
        return first.promise;
      }

      cmds.push(secondCmd);
      return second.promise;
    });

    useAsyncSelector({
      selector: function* selector() {
        return "unused";
      },
      args: {},
    });

    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).toHaveBeenCalledTimes(1);
    mocks.setState.mockClear();

    mocks.db.emit([{ id: "op-1" }]);
    mocks.db.emit([{ id: "op-2" }]);
    mocks.db.emit([{ id: "op-3" }]);

    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(1);

    first.resolve("stale");
    await flushPromises();

    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(2);

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
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending async selector result after unmount cleanup", async () => {
    const pending = deferred<string>();
    const cmd = { table: "tasks", range: "pending" };

    mocks.selectMaybeAsync.mockImplementation((_db, input) => {
      input.selectRangeCmds.push(cmd);
      return pending.promise;
    });

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
    expect(mocks.selectMaybeAsync).not.toHaveBeenCalled();
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("runs HybridDB selectors without reading cache snapshots during render", async () => {
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

    mocks.selectCachedMaybeAsync.mockImplementation((_db, input) => {
      input.selectRangeCmds.push(cmd);
      selector({ projectId: "project-1" });
      return Promise.resolve(["fresh"]);
    });

    const result = useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(result.data).toEqual([]);
    expect(result.status).toBe("pending");
    expect(result.isLoading).toBe(true);
    expect(result.isRefetching).toBe(false);
    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();
    expect(mocks.selectCachedMaybeAsync).toHaveBeenCalledWith(mocks.db, {
      selector,
      args: { projectId: "project-1" },
      selectRangeCmds: expect.any(Array),
    });
    expect(mocks.selectMaybeAsync).not.toHaveBeenCalled();

    await flushPromises();

    expect(mocks.refs[2].current).toEqual([cmd]);
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["fresh"],
        status: "success",
      }),
    );
  });

  it("waits for a pending HybridDB cache run before applying the result", async () => {
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

    mocks.selectCachedMaybeAsync.mockImplementation((_db, _input, _options) => {
      selector({ projectId: "project-1" });
      return pending.promise;
    });

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();
    expect(mocks.selectCachedMaybeAsync).toHaveBeenCalledTimes(1);

    await flushPromises();
    expect(mocks.setState).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ data: ["fresh"] }),
    );

    pending.resolve(["fresh"]);
    await flushPromises();

    expect(mocks.selectCachedMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: ["fresh"], status: "success" }),
    );
  });

  it("reruns when the DB revision changes before the initial async run is consumed", async () => {
    const stale = deferred<string[]>();
    const fresh = deferred<string[]>();
    const staleCmd = { table: "tasks", range: "stale" };
    const freshCmd = { table: "tasks", range: "fresh" };
    let runCount = 0;

    mocks.selectMaybeAsync.mockImplementation((_db, input) => {
      const cmds = input.selectRangeCmds;
      runCount++;

      if (runCount === 1) {
        cmds.push(staleCmd);
        mocks.db.emit([{ id: "between-render-and-effect" }]);
        return stale.promise;
      }

      cmds.push(freshCmd);
      return fresh.promise;
    });

    useAsyncSelector({
      selector: function* selector() {
        return ["unused"];
      },
      args: {},
      defaultValue: [],
    });

    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(2);

    stale.resolve(["stale"]);
    await flushPromises();

    expect(mocks.setState).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["stale"],
      }),
    );

    fresh.resolve(["fresh"]);
    await flushPromises();

    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["fresh"],
        status: "success",
      }),
    );
    expect(mocks.refs[2].current).toEqual([freshCmd]);
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

    mocks.selectCachedMaybeAsync
      .mockImplementationOnce((_db, _input, _options) => {
        return first.promise;
      })
      .mockImplementationOnce((_db, _input, _options) => {
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

    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();

    first.resolve(["stale-1"]);
    await flushPromises();

    expect(mocks.setState).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["stale-1"],
      }),
    );

    second.resolve(["fresh-2"]);
    await flushPromises();

    expect(mocks.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: ["fresh-2"],
        status: "success",
      }),
    );
  });

  it("does not initialize a sync HybridDB cache snapshot across selector args", () => {
    const cacheDB = {
      beginTx: vi.fn(),
      intervalScan: vi.fn(),
    };
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.selectCachedMaybeAsync.mockReturnValue(["fresh"]);
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

    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();
    expect(mocks.selectCachedMaybeAsync).toHaveBeenCalledTimes(3);
    expect(mocks.selectCachedMaybeAsync.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        selector,
        args: { projectId: "project-1" },
      }),
    );
    expect(mocks.selectCachedMaybeAsync.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        selector,
        args: { projectId: "project-1" },
      }),
    );
  });

  it("resolves refetch with the freshly fetched selector result", async () => {
    const pending = deferred<string[]>();
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });
    mocks.selectMaybeAsync.mockReturnValue(pending.promise);

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
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("does not create an active sync cache snapshot when unsubscribed", () => {
    mocks.db = Object.assign(createMockDB(), {
      cache: {
        beginTx: vi.fn(),
        intervalScan: vi.fn(),
      },
    }) as unknown as MockDB;
    const selector = vi.fn(function* selector() {
      return ["unused"];
    });

    useAsyncSelector({
      selector,
      args: {},
      defaultValue: [],
      subscribed: false,
    });

    expect(mocks.createCachedSelectorStoreSync).not.toHaveBeenCalled();
    expect(mocks.db.subscribe).not.toHaveBeenCalled();
  });

  it("applies fully synchronous async selector runs without waiting for a promise turn", () => {
    const cmd = { table: "tasks", range: "sync" };
    const selector = vi.fn(function* selector(_args: { projectId: string }) {
      return ["unused"];
    });

    mocks.selectMaybeAsync.mockImplementation((_db, input) => {
      input.selectRangeCmds.push(cmd);
      input.selector(input.args);
      return ["task-1"];
    });

    const result = useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    expect(result.data).toEqual(["task-1"]);
    expect(result.status).toBe("success");
    expect(result.isLoading).toBe(false);
    expect(selector).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.selectAsync).not.toHaveBeenCalled();
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

    mocks.selectMaybeAsync.mockImplementation((_db, input) => {
      input.selector(input.args);
      return Promise.resolve(["task-1"]);
    });

    useAsyncSelector({
      selector,
      args: { projectId: "project-1" },
      defaultValue: [],
    });

    await flushPromises();

    expect(selector).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(1);
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
    mocks.selectMaybeAsync.mockReturnValue(new Promise(() => {}));
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
    expect(mocks.selectMaybeAsync).toHaveBeenCalledTimes(2);
  });
});
