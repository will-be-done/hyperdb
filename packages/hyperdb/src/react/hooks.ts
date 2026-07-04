import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
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
  defaultValue?: SelectorReturn<TSelector> | (() => SelectorReturn<TSelector>);
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
    | {
        defaultValue:
          | SelectorReturn<TSelector>
          | (() => SelectorReturn<TSelector>);
      }
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

const createDisabledStore = <TReturn>(getDefaultValue: () => TReturn) => ({
  subscribe: () => () => {},
  getSnapshot: getDefaultValue,
});

const defaultHookDeps = {
  useCallback,
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
  const defaultValueRef = hookDeps.useRef(input.defaultValue);

  defaultValueRef.current = input.defaultValue;

  const selector = hookDeps.useMemo(() => {
    if (!enabled) {
      return createDisabledStore(
        () => defaultValueRef.current as SelectorReturn<TSelector>,
      );
    }

    return hookDeps.createCachedSelectorStoreSync(db, {
      selector: input.selector,
      args: input.args,
    });
  }, [db, input.selector, argsKey, enabled]);

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
  const defaultValueRef = hookDeps.useRef(input.defaultValue);
  const initialDataRef = hookDeps.useRef(input.initialData);
  const initialDataUpdatedAtRef = hookDeps.useRef(input.initialDataUpdatedAt);
  const placeholderDataRef = hookDeps.useRef(input.placeholderData);

  defaultValueRef.current = input.defaultValue;
  initialDataRef.current = input.initialData;
  initialDataUpdatedAtRef.current = input.initialDataUpdatedAt;
  placeholderDataRef.current = input.placeholderData;

  const storeInput = hookDeps.useMemo(() => {
    const nextInput = {
      selector: input.selector,
      args: input.args,
      enabled,
      subscribed,
    };

    if (defaultValueRef.current !== undefined) {
      Object.assign(nextInput, {
        defaultValue: () =>
          typeof defaultValueRef.current === "function"
            ? (defaultValueRef.current as () => SelectorReturn<TSelector>)()
            : defaultValueRef.current,
      });
    }
    if (initialDataRef.current !== undefined) {
      Object.assign(nextInput, {
        initialData: () =>
          typeof initialDataRef.current === "function"
            ? (initialDataRef.current as () => SelectorReturn<TSelector>)()
            : initialDataRef.current,
      });
    }
    if (initialDataUpdatedAtRef.current !== undefined) {
      Object.assign(nextInput, {
        initialDataUpdatedAt: () =>
          typeof initialDataUpdatedAtRef.current === "function"
            ? (initialDataUpdatedAtRef.current as () => number | undefined)()
            : initialDataUpdatedAtRef.current,
      });
    }
    if (placeholderDataRef.current !== undefined) {
      Object.assign(nextInput, {
        placeholderData: (
          _previousValue: SelectorReturn<TSelector> | undefined,
          previousQuery: undefined,
        ) => {
          const placeholderData = placeholderDataRef.current;

          return typeof placeholderData === "function"
            ? (
                placeholderData as (
                  previousValue: SelectorReturn<TSelector> | undefined,
                  previousQuery: undefined,
                ) => SelectorReturn<TSelector>
              )(previousDataRef.current, previousQuery)
            : placeholderData;
        },
      });
    }

    return nextInput;
  }, [
    input.selector,
    argsKey,
    enabled,
    subscribed,
    input.defaultValue !== undefined,
    input.initialData !== undefined,
    input.initialDataUpdatedAt !== undefined,
    input.placeholderData !== undefined,
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

export function useSyncDispatch() {
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
