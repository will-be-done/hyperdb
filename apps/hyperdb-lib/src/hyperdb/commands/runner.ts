import {
  isDeleteActionCmd,
  isGetCurrentTraitsCmd,
  isInsertActionCmd,
  isUpsertActionCmd,
} from "./action/commands";
import type { HyperDB } from "../core/contracts";
import { deepFreeze } from "../deep-freeze";
import { isNoopCmd, isUnwrapCmd, type DBCmd } from "./async";
import {
  isRunSelectorCmd,
  isSelectRangeCmd,
  type SelectRangeCmd,
} from "./query/commands";
import {
  isNeedToRerunRange,
  stableSerializeSelectorArgs,
} from "./query/selector-memo";
import type { Op } from "../runtime/ops";
import {
  anonymousTraceMeta,
  getTracerForDB,
  withTraceContextTrait,
  type HyperDBTracer,
  type TraceContext,
  type TraceFrame,
} from "../core/tracer";
import {
  getCommandFramePath,
  getGeneratorTraceMeta,
  wrapGeneratorWithExistingTraceMeta,
} from "../tracing/metadata";

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

export function* runCommandGenerator<TReturn>(
  db: HyperDB,
  gen: Generator<unknown, TReturn, unknown>,
  options: CommandRunnerOptions = {},
): Generator<DBCmd, TReturn, unknown> {
  const tracer = options.traceContext?.tracer ?? getTracerForDB(db);
  const traceContext =
    options.traceContext ??
    (options.skipRootTrace
      ? undefined
      : tracer?.startRootTrace(
          getGeneratorTraceMeta(gen) ?? anonymousTraceMeta(),
          db,
        ));
  const ownsTraceContext = traceContext !== undefined && !options.traceContext;
  const scopedDB = traceContext ? withTraceContextTrait(db, traceContext) : db;

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

      if (isSelectRangeCmd(cmd)) {
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
          const rows = yield* scopedDB.intervalScan(
            table,
            index,
            selectQuery.where,
            {
              limit: selectQuery.limit,
              order: selectQuery.order,
            },
          );
          if (traceContext && tracer && selectEvent) {
            tracer.endSelectEventSuccess(traceContext, selectEvent, rows);
          }
          result = gen.next(rows);
        } catch (error) {
          if (traceContext && tracer && selectEvent) {
            tracer.endSelectEventError(traceContext, selectEvent, error);
          }
          throw error;
        }
      } else if (isRunSelectorCmd(cmd)) {
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
          result = gen.next(memo.result);
        } else {
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
            ? memoizesSelf && argsKey != null
              ? new Map()
              : options.visited
            : undefined;
          // Re-wrap the freshly created body with the selector frame's own meta
          // so its scans nest under this frame instead of spawning a duplicate.
          const selectorMeta =
            traceContext && tracer && traceFrame
              ? tracer.getCurrentTraceFrameMeta(traceContext)
              : undefined;
          const body = selectorMeta
            ? wrapGeneratorWithExistingTraceMeta(cmd.makeBody(), selectorMeta)
            : cmd.makeBody();

          const value = yield* runCommandGenerator(db, body, {
            ...options,
            selectRangeCmds: childRanges,
            childMemo: scopedMemo,
            visited: scopedVisited,
            traceContext,
            skipRootTrace: options.skipRootTrace || cmd.skipTrace?.rootTrace,
            skipChildTrace:
              options.skipChildTrace || cmd.skipTrace?.childTrace,
          });

          if (argsKey != null) {
            // Drop descendants not referenced by this body run (conditional
            // branches / changed args), keeping the rest cached.
            if (scopedVisited) {
              pruneChildMemo(scopedMemo, scopedVisited);
            }
            storeChildEntry(options.childMemo, cmd.selector, argsKey, {
              selectRangeCmds: childRanges,
              result: value,
              childMemo: scopedMemo,
            });
          }
          // Bubble child ranges up so the root subscription reruns on changes
          // to the child's data.
          options.selectRangeCmds?.push(...childRanges);
          result = gen.next(value);
        }
      } else if (isInsertActionCmd(cmd)) {
        if (!options.allowWrites) {
          throw new Error("Writes are disallowed for command: insert");
        }

        result = gen.next(
          yield* runMutationCommand(scopedDB, tracer, traceContext, traceFrame, {
            kind: "insert",
            tableName: cmd.table.tableName,
            rows: cmd.values,
            run: () => scopedDB.insert(cmd.table, cmd.values),
          }),
        );
      } else if (isUpsertActionCmd(cmd)) {
        if (!options.allowWrites) {
          throw new Error("Writes are disallowed for command: upsert");
        }

        result = gen.next(
          yield* runMutationCommand(scopedDB, tracer, traceContext, traceFrame, {
            kind: "upsert",
            tableName: cmd.table.tableName,
            rows: cmd.values,
            run: () => scopedDB.upsert(cmd.table, cmd.values),
          }),
        );
      } else if (isDeleteActionCmd(cmd)) {
        if (!options.allowWrites) {
          throw new Error("Writes are disallowed for command: delete");
        }

        result = gen.next(
          yield* runMutationCommand(scopedDB, tracer, traceContext, traceFrame, {
            kind: "delete",
            tableName: cmd.table.tableName,
            ids: cmd.values,
            run: () => scopedDB.delete(cmd.table, cmd.values),
          }),
        );
      } else if (isGetCurrentTraitsCmd(cmd)) {
        result = gen.next(scopedDB.getTraits());
      } else if (isDBCmd(cmd)) {
        result = gen.next(yield cmd);
      } else {
        throw new Error(
          `Unsupported command: ${describeUnsupportedCommand(cmd)}`,
        );
      }
    }

    if (ownsTraceContext) {
      tracer?.endTraceSuccess(traceContext);
    }

    return result.value;
  } catch (error) {
    if (ownsTraceContext) {
      tracer?.endTraceError(traceContext, error);
    }

    console.error(error);

    throw error;
  }
}
