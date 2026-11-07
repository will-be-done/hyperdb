import {
  isDeleteActionCmd,
  isGetCurrentTraitsCmd,
  isInsertActionCmd,
  isUpsertActionCmd,
  isRunWithTraitsCmd,
  type DeleteActionCmd,
  type GetCurrentTraitsCmd,
  type InsertActionCmd,
  type RunWithTraitsCmd,
  type UpsertActionCmd,
} from "./action/commands";
import type { HyperDB } from "../core/contracts";
import { deepFreeze } from "../deep-freeze";
import { isNoopCmd, isUnwrapCmd, type DBCmd } from "./async";
import {
  isRunSelectorCmd,
  isSelectRangeCmd,
  type RunSelectorCmd,
  type SelectRangeCmd,
} from "./selector/commands";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./selector/selector-memo";
import type { Op } from "../runtime/ops";
import {
  anonymousTraceMeta,
  driverTraceContextFromFrameMeta,
  getDriverTraceContextForDB,
  getTracerForDB,
  withCurrentSelectEventTrait,
  withDriverTraceContextTrait,
  withTraceContextTrait,
  type HyperDBTracer,
  type TraceContext,
  type TraceFrame,
} from "../core/tracer";
import {
  getCommandFramePath,
  getGeneratorTraceMeta,
  wrapGeneratorWithExistingTracePath,
} from "../tracing/metadata";
import { HyperDBError } from "../core/errors";

export type ChildMemoEntry = {
  selectRangeCmds: SelectRangeCmd[];
  result: unknown;
  // Memo for this selector's own nested selectors. Nesting the memo means a
  // skipped (cached) node keeps its whole subtree, while pruning a node drops
  // its subtree with it.
  childMemo: ChildMemo;
};

// selector identity -> argsKey -> memoized child result + scanned ranges.
export type ChildMemo = Map<object, Map<string, ChildMemoEntry>>;

// selector identity -> argsKeys referenced during a single run.
export type ChildVisited = Map<object, Set<string>>;

export type CommandRunnerOptions = {
  allowWrites?: boolean;
  selectRangeCmds?: SelectRangeCmd[];
  traceContext?: TraceContext;
  skipRootTrace?: boolean;
  skipChildTrace?: boolean;
  // Ops that triggered this rerun. Undefined/empty on a first run, which forces
  // every nested selector to recompute.
  ops?: Op[];
  // Cross-rerun memo for nested selectors. Created once per root cache entry.
  childMemo?: ChildMemo;
  // Selectors referenced during the current run. Used to drop memo entries that
  // were not referenced this run (e.g. a child behind a conditional branch),
  // whose data could change unobserved while it is out of the subscription.
  visited?: ChildVisited;
};

const argsKeyOf = (args: unknown): string | undefined => {
  try {
    return stableSerializeSelectorArgs(args);
  } catch {
    return undefined;
  }
};

const storeChildEntry = (
  childMemo: ChildMemo | undefined,
  selector: object,
  argsKey: string,
  entry: ChildMemoEntry,
): void => {
  if (!childMemo) return;
  let byArgs = childMemo.get(selector);
  if (!byArgs) {
    byArgs = new Map();
    childMemo.set(selector, byArgs);
  }
  byArgs.set(argsKey, entry);
};

const recordVisited = (
  visited: ChildVisited | undefined,
  selector: object,
  argsKey: string,
): void => {
  if (!visited) return;
  let argsKeys = visited.get(selector);
  if (!argsKeys) {
    argsKeys = new Set();
    visited.set(selector, argsKeys);
  }
  argsKeys.add(argsKey);
};

// Drop entries (within one memo scope) not referenced during the run, so a
// child that reappears after being absent (conditional branch / changed parent
// args) recomputes against current data instead of reusing a result tracked
// while it was out of the subscription. Each scope is pruned against only the
// selectors referenced directly under it, so a skipped node's subtree — which
// is not re-walked — is preserved inside that node's own entry.
export const pruneChildMemo = (
  childMemo: ChildMemo,
  visited: ChildVisited,
): void => {
  for (const [selector, byArgs] of childMemo) {
    const visitedArgs = visited.get(selector);
    if (!visitedArgs) {
      childMemo.delete(selector);
      continue;
    }

    for (const argsKey of byArgs.keys()) {
      if (!visitedArgs.has(argsKey)) {
        byArgs.delete(argsKey);
      }
    }

    if (byArgs.size === 0) {
      childMemo.delete(selector);
    }
  }
};

const isDBCmd = (cmd: unknown): cmd is DBCmd =>
  cmd instanceof Object && cmd !== null && (isUnwrapCmd(cmd) || isNoopCmd(cmd));

const describeUnsupportedCommand = (cmd: unknown) => {
  if (cmd instanceof Object && cmd !== null && "type" in cmd) {
    return `type "${String((cmd as { type: unknown }).type)}"`;
  }

  try {
    return JSON.stringify(cmd);
  } catch {
    return String(cmd);
  }
};

type MutationTraceRecorder = {
  recordsMutationTraceEvents?(): boolean;
};

const recordsMutationTraceEvents = (db: HyperDB): boolean =>
  (db as MutationTraceRecorder).recordsMutationTraceEvents?.() === true;

function* runMutationCommand(
  db: HyperDB,
  tracer: HyperDBTracer | undefined,
  traceContext: TraceContext | undefined,
  traceFrame: TraceFrame | undefined,
  input:
    | {
        kind: "insert" | "upsert";
        tableName: string;
        rows: unknown[];
        run: () => Generator<DBCmd, void, unknown>;
      }
    | {
        kind: "delete";
        tableName: string;
        ids: string[];
        run: () => Generator<DBCmd, void, unknown>;
      },
): Generator<DBCmd, void, unknown> {
  const shouldRecordInRunner =
    traceContext !== undefined &&
    traceFrame !== undefined &&
    tracer !== undefined &&
    !recordsMutationTraceEvents(db);
  const mutationEvent = shouldRecordInRunner
    ? tracer.beginMutationEvent(traceContext, traceFrame, {
        kind: input.kind,
        tableName: input.tableName,
        ...(input.kind === "delete"
          ? { ids: input.ids }
          : { rows: input.rows, newValue: input.rows }),
      })
    : undefined;

  try {
    yield* input.run();
  } catch (error) {
    if (traceContext && tracer && mutationEvent) {
      tracer.endMutationEventError(traceContext, mutationEvent, error);
    }
    throw error;
  }

  if (traceContext && tracer && mutationEvent) {
    tracer.endMutationEventSuccess(
      traceContext,
      mutationEvent,
      input.kind === "delete"
        ? { ids: input.ids }
        : { rows: input.rows, newValue: input.rows },
    );
  }
}

type CommandContext = {
  // The DB the runner was started with; nested selectors restart from it.
  db: HyperDB;
  // `db` scoped with the active trace contexts; commands run through it.
  scopedDB: HyperDB;
  options: CommandRunnerOptions;
  tracer: HyperDBTracer | undefined;
  traceContext: TraceContext | undefined;
  traceFrame: TraceFrame | undefined;
};

// Runs one command and returns the value to resume the handler with.
type CommandHandler<TCmd> = (
  cmd: TCmd,
  ctx: CommandContext,
) => Generator<DBCmd, unknown, unknown>;

function* runSelectRange(
  cmd: SelectRangeCmd,
  { scopedDB, options, tracer, traceContext, traceFrame }: CommandContext,
): Generator<DBCmd, unknown, unknown> {
  const { table, index, selectQuery } = cmd;

  options.selectRangeCmds?.push(cmd);
  const selectEvent =
    traceContext && tracer && traceFrame
      ? tracer.beginSelectEvent(traceContext, traceFrame, {
          tableName: table.tableName,
          index,
          where: selectQuery.where,
          bounds: cmd.bounds,
          limit: selectQuery.limit,
          order: selectQuery.order,
        })
      : undefined;

  try {
    const selectDB = selectEvent
      ? withCurrentSelectEventTrait(scopedDB, selectEvent)
      : scopedDB;
    const rows = yield* selectDB.intervalScan(table, index, selectQuery.where, {
      limit: selectQuery.limit,
      order: selectQuery.order,
    });
    if (traceContext && tracer && selectEvent) {
      tracer.endSelectEventSuccess(traceContext, selectEvent, rows);
    }
    return rows;
  } catch (error) {
    if (traceContext && tracer && selectEvent) {
      tracer.endSelectEventError(traceContext, selectEvent, error);
    }
    throw error;
  }
}

function* runSelector(
  cmd: RunSelectorCmd,
  { db, options, tracer, traceContext, traceFrame }: CommandContext,
): Generator<DBCmd, unknown, unknown> {
  const memoizesSelf = cmd.memoization?.selfChild === true;
  const argsKey =
    options.childMemo !== undefined && memoizesSelf
      ? argsKeyOf(cmd.args)
      : undefined;
  if (db.getOptions?.().freezeArgs) {
    deepFreeze(cmd.args);
  }
  if (argsKey != null) {
    recordVisited(options.visited, cmd.selector, argsKey);
  }
  const memo =
    argsKey != null
      ? options.childMemo?.get(cmd.selector)?.get(argsKey)
      : undefined;

  const canSkip =
    memo !== undefined &&
    options.ops !== undefined &&
    !isNeedToRerunRange(memo.selectRangeCmds, options.ops);

  if (canSkip) {
    // Keep the root subscription covering this child's ranges even though
    // we did not rescan them this run. The entry (and its whole nested
    // childMemo) is preserved untouched.
    options.selectRangeCmds?.push(...memo.selectRangeCmds);
    if (
      traceContext &&
      tracer &&
      traceFrame &&
      !options.skipChildTrace &&
      !cmd.skipTrace?.childTrace
    ) {
      tracer.markTraceFrameCached(traceContext, traceFrame);
    }
    return memo.result;
  }

  const childRanges: SelectRangeCmd[] = [];
  // Reuse this node's existing nested memo across reruns so that, even
  // when the node itself recomputes, its unaffected descendants stay
  // cached. Non-serializable nodes can't be persisted, so their subtree
  // memo is a throwaway scope (ephemeral, recomputed each run).
  const scopedMemo: ChildMemo | undefined =
    options.childMemo === undefined
      ? undefined
      : memoizesSelf
        ? argsKey != null
          ? (memo?.childMemo ?? new Map())
          : new Map()
        : options.childMemo;
  const scopedVisited: ChildVisited | undefined = options.visited
    ? memoizesSelf
      ? new Map()
      : options.visited
    : undefined;
  // Re-wrap the freshly created body with the current trace path so its
  // scans stay under any active callback/action/selector frames.
  const selectorPath =
    traceContext && tracer && traceFrame
      ? [...traceContext.frameMetas]
      : undefined;
  const body = selectorPath
    ? wrapGeneratorWithExistingTracePath(cmd.makeBody(), selectorPath)
    : cmd.makeBody();

  const value = yield* runCommandGenerator(db, body, {
    ...options,
    selectRangeCmds: childRanges,
    childMemo: scopedMemo,
    visited: scopedVisited,
    traceContext,
    skipRootTrace: options.skipRootTrace || cmd.skipTrace?.rootTrace,
    skipChildTrace: options.skipChildTrace || cmd.skipTrace?.childTrace,
  });

  if (argsKey != null) {
    // Drop descendants not referenced by this body run (conditional
    // branches / changed args), keeping the rest cached.
    if (scopedVisited && scopedMemo) {
      pruneChildMemo(scopedMemo, scopedVisited);
    }
    storeChildEntry(options.childMemo, cmd.selector, argsKey, {
      selectRangeCmds: childRanges,
      result: value,
      childMemo: scopedMemo ?? new Map(),
    });
  }
  // Bubble child ranges up so the root subscription reruns on changes
  // to the child's data.
  options.selectRangeCmds?.push(...childRanges);
  return value;
}

const assertWritesAllowed = (
  kind: "insert" | "upsert" | "delete",
  { options }: CommandContext,
) => {
  if (!options.allowWrites) {
    throw new HyperDBError(
      "WRITES_DISALLOWED",
      `Writes are disallowed for command: ${kind}`,
    );
  }
};

const runInsert: CommandHandler<InsertActionCmd> = (cmd, ctx) => {
  assertWritesAllowed("insert", ctx);
  const { scopedDB } = ctx;
  return runMutationCommand(
    scopedDB,
    ctx.tracer,
    ctx.traceContext,
    ctx.traceFrame,
    {
      kind: "insert",
      tableName: cmd.table.tableName,
      rows: cmd.values,
      run: () => scopedDB.insert(cmd.table, cmd.values),
    },
  );
};

const runUpsert: CommandHandler<UpsertActionCmd> = (cmd, ctx) => {
  assertWritesAllowed("upsert", ctx);
  const { scopedDB } = ctx;
  return runMutationCommand(
    scopedDB,
    ctx.tracer,
    ctx.traceContext,
    ctx.traceFrame,
    {
      kind: "upsert",
      tableName: cmd.table.tableName,
      rows: cmd.values,
      run: () => scopedDB.upsert(cmd.table, cmd.values),
    },
  );
};

const runDelete: CommandHandler<DeleteActionCmd> = (cmd, ctx) => {
  assertWritesAllowed("delete", ctx);
  const { scopedDB } = ctx;
  return runMutationCommand(
    scopedDB,
    ctx.tracer,
    ctx.traceContext,
    ctx.traceFrame,
    {
      kind: "delete",
      tableName: cmd.table.tableName,
      ids: cmd.values,
      run: () => scopedDB.delete(cmd.table, cmd.values),
    },
  );
};

const runWithTraits: CommandHandler<RunWithTraitsCmd> = (
  cmd,
  { scopedDB, options, traceContext },
) =>
  runCommandGenerator(scopedDB.withTraits(...cmd.traits), cmd.body, {
    ...options,
    traceContext,
  });

function* getCurrentTraits(
  _cmd: GetCurrentTraitsCmd,
  { scopedDB }: CommandContext,
): Generator<DBCmd, unknown, unknown> {
  return scopedDB.getTraits();
}

// Storage-level commands (async unwrap, noop) go up to the executor.
function* forwardToExecutor(cmd: DBCmd): Generator<DBCmd, unknown, unknown> {
  return yield cmd;
}

const resolveCommandHandler = (
  cmd: unknown,
): ((ctx: CommandContext) => Generator<DBCmd, unknown, unknown>) => {
  if (isSelectRangeCmd(cmd)) return (ctx) => runSelectRange(cmd, ctx);
  if (isRunSelectorCmd(cmd)) return (ctx) => runSelector(cmd, ctx);
  if (isInsertActionCmd(cmd)) return (ctx) => runInsert(cmd, ctx);
  if (isUpsertActionCmd(cmd)) return (ctx) => runUpsert(cmd, ctx);
  if (isDeleteActionCmd(cmd)) return (ctx) => runDelete(cmd, ctx);
  if (isRunWithTraitsCmd(cmd)) return (ctx) => runWithTraits(cmd, ctx);
  if (isGetCurrentTraitsCmd(cmd)) return (ctx) => getCurrentTraits(cmd, ctx);
  if (isDBCmd(cmd)) return () => forwardToExecutor(cmd);

  throw new HyperDBError(
    "UNSUPPORTED_COMMAND",
    `Unsupported command: ${describeUnsupportedCommand(cmd)}`,
  );
};

export function* runCommandGenerator<TReturn>(
  db: HyperDB,
  gen: Generator<unknown, TReturn, unknown>,
  options: CommandRunnerOptions = {},
): Generator<DBCmd, TReturn, unknown> {
  const generatorMeta = getGeneratorTraceMeta(gen);
  const driverTraceContext = driverTraceContextFromFrameMeta(
    generatorMeta,
    getDriverTraceContextForDB(db),
  );
  const driverScopedDB = withDriverTraceContextTrait(db, driverTraceContext);
  const tracer = options.traceContext?.tracer ?? getTracerForDB(driverScopedDB);
  const traceContext =
    options.traceContext ??
    (options.skipRootTrace
      ? undefined
      : tracer?.startRootTrace(
          generatorMeta ?? anonymousTraceMeta(),
          driverScopedDB,
        ));
  const ownsTraceContext = traceContext !== undefined && !options.traceContext;
  const scopedDB = traceContext
    ? withTraceContextTrait(driverScopedDB, traceContext)
    : driverScopedDB;

  try {
    let result = gen.next();

    while (!result.done) {
      const cmd = result.value;
      const traceFrame = traceContext
        ? tracer?.enterFramePath(
            traceContext,
            options.skipChildTrace ? undefined : getCommandFramePath(cmd),
          )
        : undefined;
      const run = resolveCommandHandler(cmd);
      const value = yield* run({
        db,
        scopedDB,
        options,
        tracer,
        traceContext,
        traceFrame,
      });
      result = gen.next(value);
    }

    if (ownsTraceContext) {
      tracer?.endTraceSuccess(traceContext);
    }

    return result.value;
  } catch (error) {
    if (ownsTraceContext) {
      tracer?.endTraceError(traceContext, error);
    }

    throw error;
  }
}
