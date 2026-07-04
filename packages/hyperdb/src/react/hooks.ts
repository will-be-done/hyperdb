import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  createCachedSelectorStoreSync,
  runCachedSelectorMaybeAsync,
  selectCachedMaybeAsync,
  selectAsync,
  selectMaybeAsync,
  selectSync,
  type AnyObjectSelector,
  type SelectorArgs,
  type SelectorInput,
  type SelectorReturn,
} from "../hyperdb/commands/selector/selector";
import {
  createCachedSelectorStoreAsync,
  type AsyncSelectorFetchStatus,
  type AsyncSelectorRefetchOptions,
  type AsyncSelectorStatus,
} from "../hyperdb/commands/selector/async-selector-store";
import {
  asyncDispatch,
  syncDispatch,
} from "../hyperdb/commands/action/builders";
import { useDB } from "./context";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "../hyperdb/commands/selector/selector-memo";

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

export type { AsyncSelectorFetchStatus, AsyncSelectorStatus };

export type UseAsyncSelectorRefetchOptions = AsyncSelectorRefetchOptions;

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

const createDisabledStore = <TReturn>(defaultValue: TReturn) => ({
  subscribe: () => () => {},
  getSnapshot: () => defaultValue,
});

const defaultHookDeps = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useDB,
  createCachedSelectorStoreSync,
  createCachedSelectorStoreAsync,
  runCachedSelectorMaybeAsync,
  selectAsync,
  selectCachedMaybeAsync,
  selectMaybeAsync,
  selectSync,
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
  if (
    deps.selectCachedMaybeAsync &&
    deps.runCachedSelectorMaybeAsync === undefined
  ) {
    hookDeps.runCachedSelectorMaybeAsync = deps.selectCachedMaybeAsync;
  }

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

    return hookDeps.createCachedSelectorStoreSync(db, {
      selector: input.selector,
      args: input.args,
    });
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
  const argsKey = enabled
    ? hookDeps.stableSerializeSelectorArgs(input.args)
    : undefined;
  const previousDataRef = hookDeps.useRef<
    SelectorReturn<TSelector> | undefined
  >(undefined);
  const storeInput = hookDeps.useMemo(() => {
    const placeholderData =
      typeof input.placeholderData === "function"
        ? (_previousValue, previousQuery) =>
            (
              input.placeholderData as (
                previousValue: SelectorReturn<TSelector> | undefined,
                previousQuery: undefined,
              ) => SelectorReturn<TSelector>
            )(previousDataRef.current, previousQuery)
        : input.placeholderData;

    const nextInput = {
      selector: input.selector,
      args: input.args,
      enabled,
      subscribed,
    };

    if (input.defaultValue !== undefined) {
      Object.assign(nextInput, { defaultValue: input.defaultValue });
    }
    if (input.initialData !== undefined) {
      Object.assign(nextInput, { initialData: input.initialData });
    }
    if (input.initialDataUpdatedAt !== undefined) {
      Object.assign(nextInput, {
        initialDataUpdatedAt: input.initialDataUpdatedAt,
      });
    }
    if (placeholderData !== undefined) {
      Object.assign(nextInput, { placeholderData });
    }

    return nextInput;
  }, [
    input.selector,
    argsKey,
    enabled,
    subscribed,
    input.defaultValue,
    input.initialData,
    input.initialDataUpdatedAt,
    input.placeholderData,
  ]);
  const store = hookDeps.useMemo(
    () =>
      hookDeps.createCachedSelectorStoreAsync<TSelector, TError>(
        db,
        storeInput,
        {
          runCachedSelectorMaybeAsync: hookDeps.runCachedSelectorMaybeAsync,
          isNeedToRerunRange: hookDeps.isNeedToRerunRange,
        },
      ),
    [db, storeInput],
  );
  const snapshot = hookDeps.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const refetch = hookDeps.useCallback(
    async function refetch(options?: UseAsyncSelectorRefetchOptions) {
      return {
        ...(await store.refetch(options)),
        refetch,
      };
    },
    [store],
  );
  const result = hookDeps.useMemo(
    (): UseAsyncSelectorResult<SelectorReturn<TSelector>, TError> => ({
      ...snapshot,
      refetch,
    }),
    [snapshot, refetch],
  );

  hookDeps.useEffect(() => {
    return () => {
      store.destroy();
    };
  }, [store]);

  if (!result.isPlaceholderData) {
    previousDataRef.current = result.data;
  }

  if (result.isError && input.throwOnError) {
    const shouldThrow =
      typeof input.throwOnError === "function"
        ? input.throwOnError(result.error as TError, result)
        : input.throwOnError;

    if (shouldThrow) {
      throw result.error;
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

export function useSelectSync() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TSelector extends AnyObjectSelector>(
      input: SelectorInput<TSelector>,
    ): SelectorReturn<TSelector> => {
      return hookDeps.selectSync(db, input);
    },
    [db],
  );
}

export function useSelectAsync() {
  const db = hookDeps.useDB();

  return hookDeps.useCallback(
    <TSelector extends AnyObjectSelector>(
      input: SelectorInput<TSelector>,
    ): Promise<SelectorReturn<TSelector>> => {
      return hookDeps.selectAsync(db, input);
    },
    [db],
  );
}
