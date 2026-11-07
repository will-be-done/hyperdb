// Uncached selector runs: one runner for sync, async, and maybe-async modes.
import { execAsync, execMaybeAsync, execSync } from "../../core/executor";
import type { DBCmd } from "../async";
import type { HyperDB } from "../../core/contracts";
import {
  driverTraceContextFromFrameMeta,
  getDriverTraceContextForDB,
  withDriverTraceContextTrait,
} from "../../core/tracer";
import { getGeneratorTraceMeta } from "../../tracing/metadata";
import {
  pruneChildMemo,
  runCommandGenerator,
  type ChildVisited,
  type CommandRunnerOptions,
} from "../runner";
import { type SelectRangeCmd } from "./commands";
import {
  type AnyObjectSelector,
  type SelectorReturn,
  type SelectorInput,
  type SelectorRunInput,
} from "./selector-definition";

type RunSelectorOptions = Pick<CommandRunnerOptions, "ops" | "childMemo">;

const selectorGeneratorFactory =
  <TSelector extends AnyObjectSelector>(
    input: SelectorInput<TSelector>,
  ): (() => Generator<unknown, SelectorReturn<TSelector>, unknown>) =>
  () =>
    input.selector(input.args);

// When a childMemo is tracked, collect the selectors referenced this run so
// entries that were not referenced can be pruned afterwards (correctness for
// conditional branches, plus bounded memory).
const makeVisited = (options: RunSelectorOptions): ChildVisited | undefined =>
  options.childMemo ? new Map() : undefined;

function* runCommandGeneratorWithReadonlyTransaction<TReturn>(
  db: HyperDB,
  gen: Generator<unknown, TReturn, unknown>,
  options: CommandRunnerOptions,
): Generator<DBCmd, TReturn, unknown> {
  const runnerDB = withDriverTraceContextTrait(
    db,
    driverTraceContextFromFrameMeta(
      getGeneratorTraceMeta(gen),
      getDriverTraceContextForDB(db),
    ),
  );
  const tx = runnerDB.canUseReadonlyTransactionsForSelectors()
    ? yield* runnerDB.beginTx("readonly")
    : undefined;
  const scopedDB = tx ?? runnerDB;

  try {
    return yield* runCommandGenerator(scopedDB, gen, options);
  } finally {
    if (tx) {
      yield* tx.rollback();
    }
  }
}

type SelectorExecMode = "sync" | "async" | "maybeAsync";

const executors = {
  sync: execSync,
  async: execAsync,
  maybeAsync: execMaybeAsync,
} satisfies Record<
  SelectorExecMode,
  <T>(cmd: Generator<DBCmd, T>) => T | Promise<T>
>;

// In "sync" mode a Promise is the selector's own return value, never pending
// execution, so only the other modes may hand back a promise to await.
export const isPendingRun = <TReturn>(
  mode: SelectorExecMode,
  result: TReturn | Promise<TReturn>,
): result is Promise<TReturn> => mode !== "sync" && result instanceof Promise;

// One runner for every execution mode: "sync" never returns a promise,
// "async" always does, and "maybeAsync" returns one only if a step waited.
export function runSelectorGenerator<TReturn>(
  mode: SelectorExecMode,
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds: SelectRangeCmd[] = [],
  options: RunSelectorOptions = {},
): TReturn | Promise<TReturn> {
  selectRangeCmds.splice(0, selectRangeCmds.length);

  const visited = makeVisited(options);
  const prune = (value: TReturn): TReturn => {
    if (options.childMemo && visited) {
      pruneChildMemo(options.childMemo, visited);
    }
    return value;
  };
  const result = executors[mode](
    runCommandGeneratorWithReadonlyTransaction(db, gen(), {
      ...options,
      selectRangeCmds,
      visited,
    }),
  );

  return isPendingRun(mode, result) ? result.then(prune) : prune(result);
}

export const runSelectorGeneratorSync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): TReturn =>
  runSelectorGenerator("sync", db, gen, selectRangeCmds, options) as TReturn;

const runSelectorGeneratorAsync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): Promise<TReturn> =>
  runSelectorGenerator(
    "async",
    db,
    gen,
    selectRangeCmds,
    options,
  ) as Promise<TReturn>;

const runSelectorGeneratorMaybeAsync = <TReturn>(
  db: HyperDB,
  gen: () => Generator<unknown, TReturn, unknown>,
  selectRangeCmds?: SelectRangeCmd[],
  options?: RunSelectorOptions,
): TReturn | Promise<TReturn> =>
  runSelectorGenerator("maybeAsync", db, gen, selectRangeCmds, options);

export function selectSync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): SelectorReturn<TSelector> {
  return runSelectorGeneratorSync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}

export async function selectAsync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> {
  return runSelectorGeneratorAsync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}

export function selectMaybeAsync<TSelector extends AnyObjectSelector>(
  db: HyperDB,
  input: SelectorRunInput<TSelector>,
): Promise<SelectorReturn<TSelector>> | SelectorReturn<TSelector> {
  return runSelectorGeneratorMaybeAsync(
    db,
    selectorGeneratorFactory(input),
    input.selectRangeCmds ?? [],
  );
}
