import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
} from "react";
import {
  initCachedSelector,
  initSelector,
  runSelectorAsync,
  select,
  type SelectRangeCmd,
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
  type AnyObjectSelector,
  type ObjectSelector,
  type SelectorArgs,
  type SelectorReturn,
} from "../hyperdb/commands/query/selector";
import { useDB } from "./context";
import { asyncDispatch, syncDispatch } from "../hyperdb";

type SyncSelectorEnabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: true;
  defaultValue?: SelectorReturn<TSelector>;
  debugKey?: string;
  gcTime?: number;
};

type SyncSelectorMaybeDisabledOptions<
  TSelector extends AnyObjectSelector,
> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled: boolean;
  defaultValue: SelectorReturn<TSelector>;
  debugKey?: string;
  gcTime?: number;
};

type AsyncSelectorEnabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: true;
  defaultValue?: SelectorReturn<TSelector>;
  debugKey?: string;
};

type AsyncSelectorMaybeDisabledOptions<
  TSelector extends AnyObjectSelector,
> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled: boolean;
  defaultValue: SelectorReturn<TSelector>;
  debugKey?: string;
};

const isObjectSelectorOptions = (
  value: unknown,
): value is {
  selector: AnyObjectSelector;
  args: any;
  enabled?: boolean;
  defaultValue?: unknown;
  debugKey?: string;
  gcTime?: number;
} =>
  typeof value === "object" &&
  value !== null &&
  "selector" in value &&
  typeof (value as { selector?: unknown }).selector === "function";

const createDisabledStore = <TReturn>(defaultValue: TReturn) => ({
  subscribe: () => () => {},
  getSnapshot: () => defaultValue,
});

export function useSyncSelector<TSelector extends AnyObjectSelector>(
  options: SyncSelectorEnabledOptions<TSelector>,
): SelectorReturn<TSelector>;
export function useSyncSelector<TSelector extends AnyObjectSelector>(
  options: SyncSelectorMaybeDisabledOptions<TSelector>,
): SelectorReturn<TSelector>;
export function useSyncSelector<TReturn>(
  gen: () => Generator<unknown, TReturn, unknown>,
  deps: DependencyList,
  debugKey?: string,
): TReturn;
export function useSyncSelector<TReturn>(
  input:
    | (() => Generator<unknown, TReturn, unknown>)
    | SyncSelectorEnabledOptions<ObjectSelector<TReturn, any>>
    | SyncSelectorMaybeDisabledOptions<ObjectSelector<TReturn, any>>,
  deps: DependencyList = [],
  debugKey?: string,
): TReturn {
  const db = useDB();
  const isObjectForm = isObjectSelectorOptions(input);
  const enabled = !isObjectForm || input.enabled !== false;
  const argsKey =
    isObjectForm && enabled ? stableSerializeSelectorArgs(input.args) : undefined;

  const selector = useMemo(() => {
    if (isObjectForm) {
      if (!enabled) {
        return createDisabledStore(input.defaultValue);
      }

      return initCachedSelector(db, input.selector, input.args, {
        debugKey: input.debugKey,
        gcTime: input.gcTime,
      });
    }

    return initSelector(
      db,
      input as () => Generator<unknown, TReturn, unknown>,
      debugKey,
    );
  }, [
    db,
    ...(isObjectForm
      ? [
          input.selector,
          argsKey,
          enabled,
          input.defaultValue,
          input.debugKey,
          input.gcTime,
        ]
      : deps || []),
  ]);

  return useSyncExternalStore(selector.subscribe, selector.getSnapshot);
}

export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  options: AsyncSelectorEnabledOptions<TSelector> & {
    defaultValue: SelectorReturn<TSelector>;
  },
): SelectorReturn<TSelector>;
export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  options: AsyncSelectorEnabledOptions<TSelector>,
): SelectorReturn<TSelector> | undefined;
export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  options: AsyncSelectorMaybeDisabledOptions<TSelector>,
): SelectorReturn<TSelector>;
export function useAsyncSelector<TReturn>(
  gen: () => Generator<unknown, TReturn, unknown>,
  deps: DependencyList,
  debugKey?: string,
): TReturn | undefined;
export function useAsyncSelector<TReturn>(
  input:
    | (() => Generator<unknown, TReturn, unknown>)
    | AsyncSelectorEnabledOptions<ObjectSelector<TReturn, any>>
    | AsyncSelectorMaybeDisabledOptions<ObjectSelector<TReturn, any>>,
  deps: DependencyList = [],
  debugKey?: string,
): TReturn | undefined {
  const db = useDB();
  const isObjectForm = isObjectSelectorOptions(input);
  const enabled = !isObjectForm || input.enabled !== false;
  const objectDefaultValue = isObjectForm ? input.defaultValue : undefined;
  const argsKey =
    isObjectForm && enabled ? stableSerializeSelectorArgs(input.args) : undefined;
  const [result, setResult] = useState<TReturn | undefined>(
    objectDefaultValue as TReturn | undefined,
  );
  const selectRangeCmdsRef = useRef<SelectRangeCmd[]>([]);
  const genRef = useRef<() => Generator<unknown, TReturn, unknown>>(
    isObjectForm
      ? () => input.selector(input.args)
      : (input as () => Generator<unknown, TReturn, unknown>),
  );
  genRef.current = isObjectForm
    ? () => input.selector(input.args)
    : (input as () => Generator<unknown, TReturn, unknown>);

  useEffect(() => {
    if (isObjectForm) {
      setResult(objectDefaultValue as TReturn | undefined);
    }
  }, [argsKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let isRunning = false;
    let rerunRequested = false;

    const run = async () => {
      if (isRunning) {
        rerunRequested = true;
        return;
      }

      isRunning = true;
      try {
        do {
          rerunRequested = false;
          const cmds: SelectRangeCmd[] = [];
          // TODO: we can detetect if CachedDB has already cached value in range,
          // and don't spawn async/await promise that may dramatically improve performance
          const value = await runSelectorAsync(db, genRef.current, cmds);
          if (cancelled) return;

          if (rerunRequested) continue;

          selectRangeCmdsRef.current = cmds;
          setResult(value);
        } while (rerunRequested);
      } finally {
        isRunning = false;
      }
    };

    void run();

    const unsubscribe = db.subscribe((ops) => {
      if (isRunning) {
        rerunRequested = true;
        if (debugKey) {
          console.log("async selector rerun queued", debugKey, ops);
        }
        return;
      }

      // Only skip if we already have cmds AND they don't need rerun
      if (
        selectRangeCmdsRef.current.length > 0 &&
        !isNeedToRerunRange(selectRangeCmdsRef.current, ops)
      ) {
        if (debugKey) {
          console.log("async selector no need to rerun", debugKey, ops);
        }
        return;
      }

      void run();

      if (debugKey) {
        console.log("async selector callback", debugKey);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    db,
    ...(isObjectForm
      ? [input.selector, argsKey, enabled, input.debugKey]
      : deps || []),
  ]);

  if (isObjectForm && input.enabled === false) {
    return input.defaultValue as TReturn;
  }

  return result;
}

export function useDispatch() {
  const db = useDB();

  return useCallback(
    <TReturn>(action: Generator<unknown, TReturn, unknown>): TReturn => {
      return syncDispatch(db, action);
    },
    [db],
  );
}

export function useAsyncDispatch() {
  const db = useDB();

  return useCallback(
    <TReturn>(
      action: Generator<unknown, TReturn, unknown>,
    ): Promise<TReturn> => {
      return asyncDispatch(db, action);
    },
    [db],
  );
}

export function useSelect() {
  const db = useDB();

  return useCallback(
    <TReturn>(selector: Generator<unknown, TReturn, unknown>): TReturn => {
      return select(db, selector);
    },
    [db],
  );
}

export function useAsyncSelect() {
  const db = useDB();

  return useCallback(
    <TReturn>(gen: Generator<unknown, TReturn, unknown>): Promise<TReturn> => {
      return runSelectorAsync(db, () => gen);
    },
    [db],
  );
}
