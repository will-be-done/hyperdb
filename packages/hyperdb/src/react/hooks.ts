import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  initCachedSelector,
  runSelector,
  runSelectorAsync,
  runSelectorMaybeAsync,
  select,
  type AnyObjectSelector,
  type SelectorArgs,
  type SelectorReturn,
} from "../hyperdb/commands/selector/selector";
import {
  asyncDispatch,
  syncDispatch,
} from "../hyperdb/commands/action/builders";
import { useDB } from "./context";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "../hyperdb/commands/selector/selector-memo";
import type { SelectRangeCmd } from "../hyperdb/commands/selector/commands";
import type { HyperDB } from "../hyperdb/core/contracts";
import type { Op, SubscribableDB } from "../hyperdb/runtime/subscribable-db";

type SyncSelectorEnabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: true;
  defaultValue?: SelectorReturn<TSelector>;
};

type SyncSelectorMaybeDisabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled: boolean;
  defaultValue: SelectorReturn<TSelector>;
};

export type AsyncSelectorStatus = "pending" | "error" | "success";
export type AsyncSelectorFetchStatus = "fetching" | "paused" | "idle";

export type UseAsyncSelectorRefetchOptions = {
  throwOnError?: boolean;
  cancelRefetch?: boolean;
};

export type UseAsyncSelectorResult<TData, TError = unknown> = {
  data: TData | undefined;
  dataUpdatedAt: number;
  error: TError | null;
  errorUpdatedAt: number;
  errorUpdateCount: number;
  failureCount: number;
  failureReason: TError | null;
  fetchStatus: AsyncSelectorFetchStatus;
  isError: boolean;
  isFetched: boolean;
  isFetchedAfterMount: boolean;
  isFetching: boolean;
  isInitialLoading: boolean;
  isLoading: boolean;
  isLoadingError: boolean;
  isPaused: boolean;
  isPending: boolean;
  isPlaceholderData: boolean;
  isRefetchError: boolean;
  isRefetching: boolean;
  isStale: boolean;
  isSuccess: boolean;
  isEnabled: boolean;
  promise: Promise<TData>;
  refetch: (
    options?: UseAsyncSelectorRefetchOptions,
  ) => Promise<UseAsyncSelectorResult<TData, TError>>;
  status: AsyncSelectorStatus;
};

export type UseAsyncSelectorDefinedResult<
  TData,
  TError = unknown,
> = UseAsyncSelectorResult<TData, TError> & {
  data: TData;
};

type AsyncSelectorBaseOptions<
  TSelector extends AnyObjectSelector,
  TError = unknown,
> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: boolean;
  defaultValue?: SelectorReturn<TSelector>;
  initialData?: SelectorReturn<TSelector> | (() => SelectorReturn<TSelector>);
  initialDataUpdatedAt?: number | (() => number | undefined);
  placeholderData?:
    | SelectorReturn<TSelector>
    | ((
        previousValue: SelectorReturn<TSelector> | undefined,
        previousQuery: undefined,
      ) => SelectorReturn<TSelector>);
  subscribed?: boolean;
  throwOnError?:
    | boolean
    | ((
        error: TError,
        result: UseAsyncSelectorResult<SelectorReturn<TSelector>, TError>,
      ) => boolean);
};

type AsyncSelectorDefinedOptions<
  TSelector extends AnyObjectSelector,
  TError = unknown,
> = AsyncSelectorBaseOptions<TSelector, TError> &
  (
    | { defaultValue: SelectorReturn<TSelector> }
    | {
        initialData:
          | SelectorReturn<TSelector>
          | (() => SelectorReturn<TSelector>);
      }
    | {
        placeholderData:
          | SelectorReturn<TSelector>
          | ((
              previousValue: SelectorReturn<TSelector> | undefined,
              previousQuery: undefined,
            ) => SelectorReturn<TSelector>);
      }
  );

type AsyncSelectorState<TData, TError> = {
  data: TData | undefined;
  dataUpdatedAt: number;
  error: TError | null;
  errorUpdatedAt: number;
  errorUpdateCount: number;
  failureCount: number;
  failureReason: TError | null;
  fetchStatus: AsyncSelectorFetchStatus;
  isFetched: boolean;
  isFetchedAfterMount: boolean;
  isPlaceholderData: boolean;
  promise: Promise<TData>;
  status: AsyncSelectorStatus;
};

type SyncSelectorSnapshotStore<TData> = {
  enabled: boolean;
  getSnapshot: () => TData | undefined;
  refresh: () => void;
  subscribe: (callback: () => void) => () => void;
};

const createDisabledStore = <TReturn>(defaultValue: TReturn) => ({
  subscribe: () => () => {},
  getSnapshot: () => defaultValue,
});

const createInactiveSyncSelectorSnapshotStore = <
  TData,
>(): SyncSelectorSnapshotStore<TData> => ({
  enabled: false,
  getSnapshot: () => undefined,
  refresh: () => undefined,
  subscribe: () => () => undefined,
});

const isPromiseLike = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: unknown }).then === "function";

const hasOwn = <TObject extends object, TKey extends PropertyKey>(
  object: TObject,
  key: TKey,
): object is TObject & Record<TKey, unknown> =>
  Object.prototype.hasOwnProperty.call(object, key);

const resolveValue = <TValue>(value: TValue | (() => TValue)): TValue =>
  typeof value === "function" ? (value as () => TValue)() : value;

const createPromiseController = <TValue>() => {
  let resolve!: (value: TValue) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  promise.catch(() => undefined);

  return { promise, reject, resolve };
};

const readInitialDataUpdatedAt = (
  value: number | (() => number | undefined) | undefined,
) => {
  if (value === undefined) return Date.now();

  return (typeof value === "function" ? value() : value) ?? Date.now();
};

const createAsyncSelectorState = <TData, TError>(
  input: {
    defaultValue?: TData;
    initialData?: TData | (() => TData);
    initialDataUpdatedAt?: number | (() => number | undefined);
    placeholderData?:
      | TData
      | ((previousValue: TData | undefined, previousQuery: undefined) => TData);
  },
  options: {
    canFetch: boolean;
    previousData?: TData;
    promise: Promise<TData>;
  },
): AsyncSelectorState<TData, TError> => {
  if (hasOwn(input, "initialData")) {
    const data = resolveValue(input.initialData as TData | (() => TData));

    return {
      data,
      dataUpdatedAt: readInitialDataUpdatedAt(input.initialDataUpdatedAt),
      error: null,
      errorUpdatedAt: 0,
      errorUpdateCount: 0,
      failureCount: 0,
      failureReason: null,
      fetchStatus: options.canFetch ? "fetching" : "idle",
      isFetched: true,
      isFetchedAfterMount: false,
      isPlaceholderData: false,
      promise: options.promise,
      status: "success",
    };
  }

  let data: TData | undefined;
  let isPlaceholderData = false;

  if (hasOwn(input, "placeholderData")) {
    const placeholderData = input.placeholderData as
      | TData
      | ((previousValue: TData | undefined, previousQuery: undefined) => TData);
    data =
      typeof placeholderData === "function"
        ? (
            placeholderData as (
              previousValue: TData | undefined,
              previousQuery: undefined,
            ) => TData
          )(options.previousData, undefined)
        : placeholderData;
    isPlaceholderData = true;
  } else if (hasOwn(input, "defaultValue")) {
    data = input.defaultValue as TData;
    isPlaceholderData = true;
  }

  return {
    data,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: options.canFetch ? "fetching" : "idle",
    isFetched: false,
    isFetchedAfterMount: false,
    isPlaceholderData,
    promise: options.promise,
    status: "pending",
  };
};

const createUseAsyncSelectorResult = <TData, TError>(
  queryState: AsyncSelectorState<TData, TError>,
  options: {
    enabled: boolean;
    refetch: UseAsyncSelectorResult<TData, TError>["refetch"];
  },
): UseAsyncSelectorResult<TData, TError> => {
  const isStale = (() => {
    if (queryState.status !== "success") return true;

    return Date.now() > queryState.dataUpdatedAt;
  })();
  const isPending = queryState.status === "pending";
  const isError = queryState.status === "error";
  const isFetching = queryState.fetchStatus === "fetching";
  const isPaused = queryState.fetchStatus === "paused";

  return {
    ...queryState,
    isEnabled: options.enabled,
    isError,
    isFetching,
    isInitialLoading: isFetching && isPending,
    isLoading: isFetching && isPending,
    isLoadingError: isError && queryState.dataUpdatedAt === 0,
    isPaused,
    isPending,
    isRefetchError: isError && queryState.dataUpdatedAt > 0,
    isRefetching: isFetching && !isPending,
    isStale,
    isSuccess: queryState.status === "success",
    refetch: options.refetch,
  };
};

const isHyperDBLike = (value: unknown): value is HyperDB =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { intervalScan?: unknown }).intervalScan === "function" &&
  typeof (value as { beginTx?: unknown }).beginTx === "function";

const getHybridCacheDB = (db: SubscribableDB): HyperDB | undefined => {
  const maybeRoot = db as unknown as { cache?: unknown; db?: unknown };
  const maybeInner = maybeRoot.db as { cache?: unknown } | undefined;

  if (isHyperDBLike(maybeInner?.cache)) {
    return maybeInner.cache;
  }

  if (isHyperDBLike(maybeRoot.cache)) {
    return maybeRoot.cache;
  }

  return undefined;
};

const createSyncCacheSelectorSnapshotStore = <
  TSelector extends AnyObjectSelector,
>(options: {
  cacheDB: HyperDB;
  db: SubscribableDB;
  isNeedToRerunRange: (selectRangeCmds: SelectRangeCmd[], ops: Op[]) => boolean;
  runSelector: typeof runSelector;
  selector: TSelector;
  args: SelectorArgs<TSelector>;
}): SyncSelectorSnapshotStore<SelectorReturn<TSelector>> => {
  const subscribers = new Set<() => void>();
  const selectRangeCmds: SelectRangeCmd[] = [];
  const gen = () => options.selector(options.args);
  let currentResult = options.runSelector(
    options.cacheDB,
    gen,
    selectRangeCmds,
  );

  const rerun = (ops?: Op[]) => {
    currentResult = options.runSelector(options.cacheDB, gen, selectRangeCmds, {
      ops,
    });
  };

  return {
    enabled: true,
    getSnapshot: () => currentResult,
    refresh: () => {
      rerun();
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    subscribe: (callback) => {
      subscribers.add(callback);
      const unsubscribe = options.db.subscribe((ops) => {
        if (
          selectRangeCmds.length > 0 &&
          !options.isNeedToRerunRange(selectRangeCmds, ops)
        ) {
          return;
        }

        rerun(ops);
        callback();
      });

      return () => {
        subscribers.delete(callback);
        unsubscribe();
      };
    },
  };
};

const createVisibleAsyncSelectorState = <TData, TError>(
  queryState: AsyncSelectorState<TData, TError>,
  syncStore: SyncSelectorSnapshotStore<TData>,
): AsyncSelectorState<TData, TError> => {
  if (!syncStore.enabled) {
    return queryState;
  }

  return {
    ...queryState,
    data: syncStore.getSnapshot(),
    isPlaceholderData: false,
    status: queryState.status === "pending" ? "success" : queryState.status,
  };
};

const defaultHookDeps = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useDB,
  initCachedSelector,
  runSelector,
  runSelectorAsync,
  runSelectorMaybeAsync,
  select,
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
  syncDispatch,
  asyncDispatch,
};

let hookDeps = defaultHookDeps;

export function setHyperDBHookDepsForTest(
  deps: Partial<typeof defaultHookDeps>,
): () => void {
  hookDeps = { ...defaultHookDeps, ...deps };

  return () => {
    hookDeps = defaultHookDeps;
  };
}

export function useSyncSelector<TSelector extends AnyObjectSelector>(
  options: SyncSelectorEnabledOptions<TSelector>,
): SelectorReturn<TSelector>;
export function useSyncSelector<TSelector extends AnyObjectSelector>(
  options: SyncSelectorMaybeDisabledOptions<TSelector>,
): SelectorReturn<TSelector>;
export function useSyncSelector<TSelector extends AnyObjectSelector>(
  input:
    | SyncSelectorEnabledOptions<TSelector>
    | SyncSelectorMaybeDisabledOptions<TSelector>,
): SelectorReturn<TSelector> {
  const db = hookDeps.useDB();
  const enabled = input.enabled !== false;
  const argsKey = enabled
    ? hookDeps.stableSerializeSelectorArgs(input.args)
    : undefined;

  const selector = hookDeps.useMemo(() => {
    if (!enabled) {
      return createDisabledStore(
        input.defaultValue as SelectorReturn<TSelector>,
      );
    }

    return hookDeps.initCachedSelector(db, input.selector, input.args);
  }, [db, input.selector, argsKey, enabled, input.defaultValue]);

  return hookDeps.useSyncExternalStore(
    selector.subscribe,
    selector.getSnapshot,
    selector.getSnapshot,
  );
}

export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  options: AsyncSelectorDefinedOptions<TSelector>,
): UseAsyncSelectorDefinedResult<SelectorReturn<TSelector>>;
export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  options: AsyncSelectorBaseOptions<TSelector>,
): UseAsyncSelectorResult<SelectorReturn<TSelector>>;
export function useAsyncSelector<
  TSelector extends AnyObjectSelector,
  TError = unknown,
>(
  input: AsyncSelectorBaseOptions<TSelector, TError>,
): UseAsyncSelectorResult<SelectorReturn<TSelector>, TError> {
  const db = hookDeps.useDB();
  const enabled = input.enabled !== false;
  const subscribed = input.subscribed !== false;
  const canFetch = enabled && subscribed;
  const argsKey = enabled
    ? hookDeps.stableSerializeSelectorArgs(input.args)
    : undefined;
  const syncSnapshotStore = hookDeps.useMemo(() => {
    const cacheDB = enabled ? getHybridCacheDB(db) : undefined;
    if (!cacheDB) {
      return createInactiveSyncSelectorSnapshotStore<
        SelectorReturn<TSelector>
      >();
    }

    return createSyncCacheSelectorSnapshotStore({
      args: input.args,
      cacheDB,
      db,
      isNeedToRerunRange: hookDeps.isNeedToRerunRange,
      runSelector: hookDeps.runSelector,
      selector: input.selector,
    });
  }, [db, input.selector, argsKey, enabled]);
  const syncSnapshot = hookDeps.useSyncExternalStore(
    syncSnapshotStore.subscribe,
    syncSnapshotStore.getSnapshot,
    syncSnapshotStore.getSnapshot,
  );
  const promiseControllerRef = hookDeps.useRef(
    createPromiseController<SelectorReturn<TSelector>>(),
  );
  const [queryState, setQueryStateRaw] = hookDeps.useState<
    AsyncSelectorState<SelectorReturn<TSelector>, TError>
  >(() =>
    createAsyncSelectorState<SelectorReturn<TSelector>, TError>(input, {
      canFetch,
      promise: promiseControllerRef.current.promise,
    }),
  );
  const queryStateRef = hookDeps.useRef(queryState);
  const selectRangeCmdsRef = hookDeps.useRef<SelectRangeCmd[]>([]);
  const syncSnapshotStoreRef = hookDeps.useRef(syncSnapshotStore);
  const isRunningRef = hookDeps.useRef(false);
  const rerunRequestedRef = hookDeps.useRef(false);
  const cancelledRef = hookDeps.useRef(false);
  const inFlightResultRef = hookDeps.useRef<Promise<
    UseAsyncSelectorResult<SelectorReturn<TSelector>, TError>
  > | null>(null);
  const resultRef = hookDeps.useRef<
    UseAsyncSelectorResult<SelectorReturn<TSelector>, TError>
  >(
    undefined as unknown as UseAsyncSelectorResult<
      SelectorReturn<TSelector>,
      TError
    >,
  );
  const genRef = hookDeps.useRef<
    () => Generator<unknown, SelectorReturn<TSelector>, unknown>
  >(() => input.selector(input.args));
  const runRef = hookDeps.useRef<
    (
      options?: UseAsyncSelectorRefetchOptions,
    ) => Promise<UseAsyncSelectorResult<SelectorReturn<TSelector>, TError>>
  >(() => Promise.resolve(resultRef.current));
  genRef.current = () => input.selector(input.args);
  syncSnapshotStoreRef.current = syncSnapshotStore;

  const setQueryState = hookDeps.useCallback(
    (
      updater: (
        previous: AsyncSelectorState<SelectorReturn<TSelector>, TError>,
      ) => AsyncSelectorState<SelectorReturn<TSelector>, TError>,
    ) => {
      const next = updater(queryStateRef.current);
      queryStateRef.current = next;
      setQueryStateRaw(next);
      return next;
    },
    [],
  );

  const refetch = hookDeps.useCallback(
    (options?: UseAsyncSelectorRefetchOptions) => runRef.current(options),
    [],
  );

  const visibleQueryState = createVisibleAsyncSelectorState(queryState, {
    ...syncSnapshotStore,
    getSnapshot: () => syncSnapshot,
  });
  const result = createUseAsyncSelectorResult(visibleQueryState, {
    enabled,
    refetch,
  });
  resultRef.current = result;

  hookDeps.useEffect(() => {
    const promiseController =
      createPromiseController<SelectorReturn<TSelector>>();
    promiseControllerRef.current = promiseController;
    selectRangeCmdsRef.current = [];
    setQueryState((previous) =>
      createAsyncSelectorState<SelectorReturn<TSelector>, TError>(input, {
        canFetch,
        previousData: previous.data,
        promise: promiseController.promise,
      }),
    );
  }, [argsKey]);

  hookDeps.useEffect(() => {
    cancelledRef.current = false;

    const run = (options?: UseAsyncSelectorRefetchOptions) => {
      if (isRunningRef.current) {
        rerunRequestedRef.current = true;

        if (
          options?.cancelRefetch === false &&
          inFlightResultRef.current !== null
        ) {
          return inFlightResultRef.current;
        }

        return inFlightResultRef.current ?? Promise.resolve(resultRef.current);
      }

      isRunningRef.current = true;
      const promiseController =
        createPromiseController<SelectorReturn<TSelector>>();
      promiseControllerRef.current = promiseController;
      const resultPromise = new Promise<
        UseAsyncSelectorResult<SelectorReturn<TSelector>, TError>
      >((resolve, reject) => {
        const resolveCurrentResult = () => {
          resolve(resultRef.current);
        };
        const finishSuccess = (
          value: SelectorReturn<TSelector>,
          cmds: SelectRangeCmd[],
        ) => {
          if (cancelledRef.current) return;

          selectRangeCmdsRef.current = cmds;
          syncSnapshotStoreRef.current.refresh();
          const nextState = setQueryState((previous) => ({
            ...previous,
            data: value,
            dataUpdatedAt: Date.now(),
            error: null,
            failureCount: 0,
            failureReason: null,
            fetchStatus: "idle",
            isFetched: true,
            isFetchedAfterMount: true,
            isPlaceholderData: false,
            status: "success",
          }));
          resultRef.current = createUseAsyncSelectorResult(
            createVisibleAsyncSelectorState(
              nextState,
              syncSnapshotStoreRef.current,
            ),
            {
              enabled,
              refetch,
            },
          );
          promiseController.resolve(value);
          isRunningRef.current = false;
          inFlightResultRef.current = null;
          resolveCurrentResult();

          if (rerunRequestedRef.current && !cancelledRef.current) {
            void run();
          }
        };
        const finishError = (error: unknown) => {
          if (cancelledRef.current) return;

          const typedError = error as TError;
          const nextState = setQueryState((previous) => ({
            ...previous,
            error: typedError,
            errorUpdatedAt: Date.now(),
            errorUpdateCount: previous.errorUpdateCount + 1,
            failureCount: previous.failureCount + 1,
            failureReason: typedError,
            fetchStatus: "idle",
            isFetched: true,
            isFetchedAfterMount: true,
            isPlaceholderData: false,
            status: "error",
          }));
          resultRef.current = createUseAsyncSelectorResult(
            createVisibleAsyncSelectorState(
              nextState,
              syncSnapshotStoreRef.current,
            ),
            {
              enabled,
              refetch,
            },
          );
          promiseController.reject(error);
          isRunningRef.current = false;
          inFlightResultRef.current = null;

          if (options?.throwOnError === true) {
            reject(error);
            return;
          }

          resolveCurrentResult();
        };
        const runOnce = () => {
          try {
            do {
              rerunRequestedRef.current = false;
              const cmds: SelectRangeCmd[] = [];

              const value = hookDeps.runSelectorMaybeAsync(
                db,
                genRef.current,
                cmds,
              );

              if (isPromiseLike(value)) {
                void Promise.resolve(value).then(
                  (resolvedValue) => {
                    if (cancelledRef.current) {
                      return;
                    }

                    if (rerunRequestedRef.current) {
                      runOnce();
                      return;
                    }

                    finishSuccess(resolvedValue, cmds);
                  },
                  (error: unknown) => {
                    finishError(error);
                  },
                );
                return;
              }

              if (cancelledRef.current) {
                isRunningRef.current = false;
                return;
              }

              if (rerunRequestedRef.current) continue;

              finishSuccess(value, cmds);
              return;
            } while (rerunRequestedRef.current);
          } catch (error) {
            finishError(error);
          }
        };

        setQueryState((previous) => ({
          ...previous,
          fetchStatus: "fetching",
          promise: promiseController.promise,
          status:
            previous.status === "success" || previous.dataUpdatedAt > 0
              ? previous.status
              : "pending",
        }));

        runOnce();
      });

      if (isRunningRef.current) {
        inFlightResultRef.current = resultPromise;
      }

      return resultPromise;
    };
    runRef.current = run;

    if (!canFetch) {
      return;
    }

    void run();

    const unsubscribe = db.subscribe((ops) => {
      if (isRunningRef.current) {
        rerunRequestedRef.current = true;
        return;
      }

      // Only skip if we already have cmds AND they don't need rerun
      if (
        selectRangeCmdsRef.current.length > 0 &&
        !hookDeps.isNeedToRerunRange(selectRangeCmdsRef.current, ops)
      ) {
        return;
      }

      void run();
    });

    return () => {
      cancelledRef.current = true;
      isRunningRef.current = false;
      unsubscribe();
    };
  }, [db, input.selector, argsKey, canFetch, enabled, refetch]);

  if (result.isError && input.throwOnError) {
    const shouldThrow =
      typeof input.throwOnError === "function"
        ? input.throwOnError(queryState.error as TError, result)
        : input.throwOnError;

    if (shouldThrow) {
      throw queryState.error;
    }
  }

  return result;
}

export function useDispatch() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TReturn>(action: Generator<unknown, TReturn, unknown>): TReturn => {
      return hookDeps.syncDispatch(db, action);
    },
    [db],
  );
}

export function useAsyncDispatch() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TReturn>(
      action: Generator<unknown, TReturn, unknown>,
    ): Promise<TReturn> => {
      return hookDeps.asyncDispatch(db, action);
    },
    [db],
  );
}

export function useSelect() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TReturn>(selector: Generator<unknown, TReturn, unknown>): TReturn => {
      return hookDeps.select(db, selector);
    },
    [db],
  );
}

export function useAsyncSelect() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TReturn>(gen: Generator<unknown, TReturn, unknown>): Promise<TReturn> => {
      return hookDeps.runSelectorAsync(db, () => gen);
    },
    [db],
  );
}
