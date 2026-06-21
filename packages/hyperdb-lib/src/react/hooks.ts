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
  runSelectorAsync,
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

type SyncSelectorEnabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: true;
  defaultValue?: SelectorReturn<TSelector>;
  gcTime?: number;
};

type SyncSelectorMaybeDisabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled: boolean;
  defaultValue: SelectorReturn<TSelector>;
  gcTime?: number;
};

type AsyncSelectorEnabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled?: true;
  defaultValue?: SelectorReturn<TSelector>;
};

type AsyncSelectorMaybeDisabledOptions<TSelector extends AnyObjectSelector> = {
  selector: TSelector;
  args: SelectorArgs<TSelector>;
  enabled: boolean;
  defaultValue: SelectorReturn<TSelector>;
};

const createDisabledStore = <TReturn>(defaultValue: TReturn) => ({
  subscribe: () => () => {},
  getSnapshot: () => defaultValue,
});

const defaultHookDeps = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useDB,
  initCachedSelector,
  runSelectorAsync,
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

    return hookDeps.initCachedSelector(db, input.selector, input.args, {
      gcTime: input.gcTime,
    });
  }, [db, input.selector, argsKey, enabled, input.defaultValue, input.gcTime]);

  return hookDeps.useSyncExternalStore(
    selector.subscribe,
    selector.getSnapshot,
    selector.getSnapshot,
  );
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
export function useAsyncSelector<TSelector extends AnyObjectSelector>(
  input:
    | AsyncSelectorEnabledOptions<TSelector>
    | AsyncSelectorMaybeDisabledOptions<TSelector>,
): SelectorReturn<TSelector> | undefined {
  const db = hookDeps.useDB();
  const enabled = input.enabled !== false;
  const argsKey = enabled
    ? hookDeps.stableSerializeSelectorArgs(input.args)
    : undefined;
  const [result, setResult] = hookDeps.useState<
    SelectorReturn<TSelector> | undefined
  >(input.defaultValue);
  const selectRangeCmdsRef = hookDeps.useRef<SelectRangeCmd[]>([]);
  const genRef = hookDeps.useRef<
    () => Generator<unknown, SelectorReturn<TSelector>, unknown>
  >(() => input.selector(input.args));
  genRef.current = () => input.selector(input.args);

  hookDeps.useEffect(() => {
    if ("defaultValue" in input) {
      setResult(input.defaultValue);
    }
  }, [argsKey]);

  hookDeps.useEffect(() => {
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
          const value = await hookDeps.runSelectorAsync(
            db,
            genRef.current,
            cmds,
          );
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
      cancelled = true;
      unsubscribe();
    };
  }, [db, input.selector, argsKey, enabled]);

  if (input.enabled === false) {
    return input.defaultValue;
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
