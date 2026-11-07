import { bench, describe } from "vitest";
import type { Op } from "../../runtime/ops";
import { defineTable } from "../../schema/table";
import { v } from "../../schema/values";
import { selectFrom } from "./builder";
import { isSelectRangeCmd, type SelectRangeCmd } from "./commands";
import { isNeedToRerunRange } from "./selector-memo";

const tasks = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  order: v.string(),
}).index("byProjectOrder", ["projectId", "order"]);

const rangeCmd = (projectId: string): SelectRangeCmd => {
  const query = selectFrom(tasks, "byProjectOrder").where((q) =>
    q.eq("projectId", projectId),
  );
  const cmd: unknown = query[Symbol.iterator]().next().value;
  if (!isSelectRangeCmd(cmd)) throw new Error("expected a range command");
  return cmd;
};

// One cached selector per project, each reading two ranges. Every commit
// writes to a project no selector reads, so every check is a miss and has to
// look at every op: the worst case for a commit.
const cachedSelectors = (count: number): SelectRangeCmd[][] =>
  Array.from({ length: count }, (_, i) => [
    rangeCmd(`project-${i}`),
    rangeCmd(`project-${i}`),
  ]);

const commitOps = (count: number): Op[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "upsert",
    table: tasks,
    oldValue: { id: `task-${i}`, projectId: "project-hot", order: `a${i}` },
    newValue: { id: `task-${i}`, projectId: "project-hot", order: `b${i}` },
  }));

let _rerunSink = 0;

describe("isNeedToRerunRange on a commit no selector reads", () => {
  for (const [selectorCount, opCount] of [
    [1_000, 1],
    [1_000, 50],
    [5_000, 1],
    [5_000, 50],
  ] as const) {
    const selectors = cachedSelectors(selectorCount);

    bench(
      `${selectorCount} selectors x ${opCount} ops`,
      () => {
        // Each subscriber sees the same ops array, as on a real commit.
        const ops = commitOps(opCount);
        let reruns = 0;
        for (const cmds of selectors) {
          if (isNeedToRerunRange(cmds, ops)) reruns++;
        }
        _rerunSink = reruns;
      },
      { time: 1000 },
    );
  }
});

export const readBenchSink = () => _rerunSink;
