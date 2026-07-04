import type { Op, SubscribableDB } from "../../runtime/subscribable-db";
import type { SelectRangeCmd } from "./commands";
import {
  runCachedSelectorMaybeAsync,
  selectMaybeAsync,
  type AnyObjectSelector,
  type SelectorArgs,
  type SelectorReturn,
} from "./selector";
import { isNeedToRerunRange } from "./selector-memo";

export type AsyncSelectorStatus = "pending" | "error" | "success";
export type AsyncSelectorFetchStatus = "fetching" | "paused" | "idle";

export type AsyncSelectorRefetchOptions = {
  throwOnError?: boolean;
  cancelRefetch?: boolean;
};

export type AsyncSelectorStateLike<TData, TError = unknown> = {
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
  status: AsyncSelectorStatus;
};

export type AsyncSelectorStoreInput<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: boolean;
  subscribed?: boolean;
  defaultValue?: SelectorReturn<TSelector> | (() => SelectorReturn<TSelector>);
  initialData?: SelectorReturn<TSelector> | (() => SelectorReturn<TSelector>);
  initialDataUpdatedAt?: number | (() => number | undefined);
  placeholderData?:
    | SelectorReturn<TSelector>
    | ((
        previousValue: SelectorReturn<TSelector> | undefined,
        previousQuery: undefined,
      ) => SelectorReturn<TSelector>);
  staleTime?: number;
  gcTime?: number;
};

export type AsyncSelectorStore<TData, TError = unknown> = {
  subscribe(callback: () => void): () => void;
  getSnapshot(): AsyncSelectorStateLike<TData, TError>;
  refetch(
    options?: AsyncSelectorRefetchOptions,
  ): Promise<AsyncSelectorStateLike<TData, TError>>;
  destroy(): void;
};

export type CachedSelectorStoreAsyncInput<TSelector extends AnyObjectSelector> =
  AsyncSelectorStoreInput<TSelector>;

export type CachedSelectorStoreAsync<
  TData,
  TError = unknown,
> = AsyncSelectorStore<TData, TError>;

export type AsyncSelectorStoreDeps = {
  runCachedSelectorMaybeAsync: typeof runCachedSelectorMaybeAsync;
  isNeedToRerunRange: typeof isNeedToRerunRange;
};

export type CachedSelectorStoreAsyncDeps = AsyncSelectorStoreDeps;

type AsyncSelectorStoreInternalDeps = AsyncSelectorStoreDeps & {
  selectMaybeAsync: typeof selectMaybeAsync;
};

type AsyncSelectorStateCore<TData, TError> = {
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

type PromiseController<TValue> = ReturnType<
  typeof createPromiseController<TValue>
>;

const readInitialDataUpdatedAt = (
  value: number | (() => number | undefined) | undefined,
) => {
  if (value === undefined) return Date.now();

  return (typeof value === "function" ? value() : value) ?? Date.now();
};

const createInitialState = <TData, TError>(
  input: {
    defaultValue?: TData | (() => TData);
    initialData?: TData | (() => TData);
    initialDataUpdatedAt?: number | (() => number | undefined);
    placeholderData?:
      | TData
      | ((previousValue: TData | undefined, previousQuery: undefined) => TData);
  },
  options: {
    canAutoFetch: boolean;
    promise: Promise<TData>;
  },
): AsyncSelectorStateCore<TData, TError> => {
  if (hasOwn(input, "initialData") && input.initialData !== undefined) {
    const data = resolveValue(input.initialData as TData | (() => TData));

    return {
      data,
      dataUpdatedAt: readInitialDataUpdatedAt(input.initialDataUpdatedAt),
      error: null,
      errorUpdatedAt: 0,
      errorUpdateCount: 0,
      failureCount: 0,
      failureReason: null,
      fetchStatus: options.canAutoFetch ? "fetching" : "idle",
      isFetched: true,
      isFetchedAfterMount: false,
      isPlaceholderData: false,
      promise: options.promise,
      status: "success",
    };
  }

  let data: TData | undefined;
  let isPlaceholderData = false;

  if (hasOwn(input, "placeholderData") && input.placeholderData !== undefined) {
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
          )(undefined, undefined)
        : placeholderData;
    isPlaceholderData = true;
  } else if (
    hasOwn(input, "defaultValue") &&
    input.defaultValue !== undefined
  ) {
    data = resolveValue(input.defaultValue as TData | (() => TData));
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
    fetchStatus: options.canAutoFetch ? "fetching" : "idle",
    isFetched: false,
    isFetchedAfterMount: false,
    isPlaceholderData,
    promise: options.promise,
    status: "pending",
  };
};

const buildSnapshot = <TData, TError>(
  queryState: AsyncSelectorStateCore<TData, TError>,
  options: { enabled: boolean; staleTime: number },
): AsyncSelectorStateLike<TData, TError> => {
  const isPending = queryState.status === "pending";
  const isError = queryState.status === "error";
  const isFetching = queryState.fetchStatus === "fetching";
  const isPaused = queryState.fetchStatus === "paused";
  const isStale =
    queryState.status !== "success" ||
    Date.now() > queryState.dataUpdatedAt + options.staleTime;

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
  };
};

const createAsyncSelectorStoreInternal = <
  TSelector extends AnyObjectSelector,
  TError = unknown,
>(
  db: SubscribableDB,
  input: AsyncSelectorStoreInput<TSelector>,
  deps: Partial<AsyncSelectorStoreInternalDeps>,
  options: { cached: boolean },
): AsyncSelectorStore<SelectorReturn<TSelector>, TError> => {
  type TData = SelectorReturn<TSelector>;

  const enabled = input.enabled !== false;
  const subscribed = input.subscribed !== false;
  const canAutoFetch = enabled && subscribed;
  const staleTime = input.staleTime ?? 0;
  const storeDeps: AsyncSelectorStoreInternalDeps = {
    runCachedSelectorMaybeAsync,
    selectMaybeAsync,
    isNeedToRerunRange,
    ...deps,
  };
  const listeners = new Set<() => void>();
  let destroyed = false;
  let started = false;
  let isRunning = false;
  let rerunRequested = false;
  let inFlightResult: Promise<AsyncSelectorStateLike<TData, TError>> | null =
    null;
  let activeRun: {
    token: number;
    dataController: PromiseController<TData>;
    resultController: PromiseController<AsyncSelectorStateLike<TData, TError>>;
    cancelOnLastUnsubscribe: boolean;
  } | null = null;
  let dbUnsubscribe: (() => void) | undefined;
  let runToken = 0;
  let runRevision = db.getRevision();
  let selectRangeCmds: SelectRangeCmd[] = [];
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const initialPromiseController = createPromiseController<TData>();
  let queryState = createInitialState<TData, TError>(input, {
    canAutoFetch,
    promise: initialPromiseController.promise,
  });
  let snapshot = buildSnapshot(queryState, { enabled, staleTime });

  const clearStaleTimer = () => {
    if (!staleTimer) return;
    clearTimeout(staleTimer);
    staleTimer = undefined;
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const refreshStaleSnapshot = () => {
    if (
      queryState.status !== "success" ||
      staleTime <= 0 ||
      snapshot.isStale ||
      Date.now() <= queryState.dataUpdatedAt + staleTime
    ) {
      return;
    }

    snapshot = buildSnapshot(queryState, { enabled, staleTime });
  };

  const scheduleStaleTimer = () => {
    clearStaleTimer();

    if (
      destroyed ||
      listeners.size === 0 ||
      queryState.status !== "success" ||
      staleTime <= 0 ||
      snapshot.isStale
    ) {
      return;
    }

    const staleAt = queryState.dataUpdatedAt + staleTime;
    const delay = staleAt - Date.now() + 1;
    staleTimer = setTimeout(
      () => {
        snapshot = buildSnapshot(queryState, { enabled, staleTime });
        notify();
      },
      Math.max(delay, 0),
    );
    (staleTimer as { unref?: () => void }).unref?.();
  };

  const setQueryState = (
    updater: (
      previous: AsyncSelectorStateCore<TData, TError>,
    ) => AsyncSelectorStateCore<TData, TError>,
  ) => {
    if (destroyed) return;

    const next = updater(queryState);
    if (next === queryState) return;

    queryState = next;
    snapshot = buildSnapshot(queryState, { enabled, staleTime });
    scheduleStaleTimer();
    notify();
  };

  const runSelector = (cmds: SelectRangeCmd[]) => {
    if (!options.cached) {
      return storeDeps.selectMaybeAsync(db, {
        selector: input.selector,
        args: input.args,
        selectRangeCmds: cmds,
      });
    }

    return storeDeps.runCachedSelectorMaybeAsync(db, {
      selector: input.selector,
      args: input.args,
      selectRangeCmds: cmds,
      gcTime: input.gcTime,
    });
  };

  const stopDBSubscription = () => {
    dbUnsubscribe?.();
    dbUnsubscribe = undefined;
  };

  const cancelInFlightRun = () => {
    runToken++;

    if (activeRun) {
      const cancelledQueryState = {
        ...queryState,
        fetchStatus: "idle" as const,
      };
      const cancelledSnapshot = buildSnapshot(cancelledQueryState, {
        enabled,
        staleTime,
      });

      queryState = cancelledQueryState;
      snapshot = cancelledSnapshot;
      activeRun.dataController.reject(
        new Error("Async selector run was cancelled"),
      );
      activeRun.resultController.resolve(cancelledSnapshot);
      activeRun = null;
    }

    isRunning = false;
    inFlightResult = null;
    rerunRequested = false;
  };

  const run = (
    options?: AsyncSelectorRefetchOptions,
    runOptions: { cancelOnLastUnsubscribe?: boolean } = {},
  ): Promise<AsyncSelectorStateLike<TData, TError>> => {
    const applyRefetchOptions = (
      resultPromise: Promise<AsyncSelectorStateLike<TData, TError>>,
    ) => {
      if (options?.throwOnError !== true) return resultPromise;

      return resultPromise.then((result) => {
        if (result.isError) {
          throw result.error;
        }

        return result;
      });
    };

    started = true;

    if (isRunning) {
      rerunRequested = true;
      const currentResult = inFlightResult ?? Promise.resolve(snapshot);

      if (options?.cancelRefetch === false && inFlightResult !== null) {
        return applyRefetchOptions(inFlightResult);
      }

      return applyRefetchOptions(currentResult);
    }

    const currentToken = ++runToken;
    isRunning = true;
    runRevision = db.getRevision();
    const promiseController = createPromiseController<TData>();
    const resultController =
      createPromiseController<AsyncSelectorStateLike<TData, TError>>();
    activeRun = {
      token: currentToken,
      dataController: promiseController,
      resultController,
      cancelOnLastUnsubscribe: runOptions.cancelOnLastUnsubscribe !== false,
    };

    const resultPromise = resultController.promise;
    const isCurrentRun = () =>
      !destroyed &&
      currentToken === runToken &&
      activeRun?.token === currentToken;
    const resolveCurrentSnapshot = () => {
      resultController.resolve(snapshot);
    };
    const finishSuccess = (value: TData, cmds: SelectRangeCmd[]) => {
      const currentRun = activeRun;
      if (!isCurrentRun() || !currentRun) return;

      const cancelOnLastUnsubscribe = currentRun.cancelOnLastUnsubscribe;

      selectRangeCmds = cmds;
      setQueryState((previous) => ({
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
      promiseController.resolve(value);
      isRunning = false;
      inFlightResult = null;
      activeRun = null;
      resolveCurrentSnapshot();

      if (rerunRequested && !destroyed) {
        void run(undefined, { cancelOnLastUnsubscribe });
      }
    };
    const finishError = (error: unknown) => {
      if (!isCurrentRun()) return;

      const typedError = error as TError;
      setQueryState((previous) => ({
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
      promiseController.reject(error);
      isRunning = false;
      inFlightResult = null;
      activeRun = null;

      resolveCurrentSnapshot();
    };
    const runOnce = () => {
      try {
        do {
          rerunRequested = false;
          const cmds: SelectRangeCmd[] = [];
          const value = runSelector(cmds);

          if (isPromiseLike(value)) {
            void Promise.resolve(value).then(
              (resolvedValue) => {
                if (!isCurrentRun()) {
                  return;
                }

                if (rerunRequested) {
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

          if (!isCurrentRun()) {
            isRunning = false;
            inFlightResult = null;
            return;
          }

          if (rerunRequested) continue;

          finishSuccess(value, cmds);
          return;
        } while (rerunRequested);
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

    if (isRunning) {
      inFlightResult = resultPromise;
    }

    return applyRefetchOptions(resultPromise);
  };

  const ensureStarted = () => {
    if (started || !canAutoFetch || destroyed) return;

    void run(undefined, { cancelOnLastUnsubscribe: false });
  };

  const ensureDBSubscription = () => {
    if (dbUnsubscribe || !canAutoFetch || destroyed) return;

    dbUnsubscribe = db.subscribe((ops: Op[]) => {
      if (isRunning) {
        rerunRequested = true;
        return;
      }

      if (
        selectRangeCmds.length > 0 &&
        !storeDeps.isNeedToRerunRange(selectRangeCmds, ops)
      ) {
        return;
      }

      void run(undefined, { cancelOnLastUnsubscribe: false });
    });
  };

  return {
    subscribe: (callback) => {
      listeners.add(callback);
      refreshStaleSnapshot();
      scheduleStaleTimer();
      ensureDBSubscription();
      ensureStarted();

      if (canAutoFetch && runRevision !== db.getRevision()) {
        if (isRunning) {
          rerunRequested = true;
        } else {
          void run(undefined, { cancelOnLastUnsubscribe: false });
        }
      }

      return () => {
        listeners.delete(callback);

        if (listeners.size > 0) return;

        stopDBSubscription();
        rerunRequested = false;
        if (activeRun?.cancelOnLastUnsubscribe !== false) {
          cancelInFlightRun();
        }
        if (!activeRun && queryState.status !== "success") {
          started = false;
        }
        clearStaleTimer();
      };
    },
    getSnapshot: () => {
      ensureStarted();
      refreshStaleSnapshot();
      return snapshot;
    },
    refetch: (options) => run(options),
    destroy: () => {
      if (destroyed) return;

      destroyed = true;
      cancelInFlightRun();
      stopDBSubscription();
      clearStaleTimer();
      listeners.clear();
    },
  };
};

export function createAsyncSelectorStore<
  TSelector extends AnyObjectSelector,
  TError = unknown,
>(
  db: SubscribableDB,
  input: AsyncSelectorStoreInput<TSelector>,
  deps: Partial<
    Pick<
      AsyncSelectorStoreInternalDeps,
      "selectMaybeAsync" | "isNeedToRerunRange"
    >
  > = {},
): AsyncSelectorStore<SelectorReturn<TSelector>, TError> {
  return createAsyncSelectorStoreInternal<TSelector, TError>(db, input, deps, {
    cached: false,
  });
}

export function createCachedSelectorStoreAsync<
  TSelector extends AnyObjectSelector,
  TError = unknown,
>(
  db: SubscribableDB,
  input: CachedSelectorStoreAsyncInput<TSelector>,
  deps: Partial<CachedSelectorStoreAsyncDeps> = {},
): CachedSelectorStoreAsync<SelectorReturn<TSelector>, TError> {
  return createAsyncSelectorStoreInternal<TSelector, TError>(db, input, deps, {
    cached: true,
  });
}
