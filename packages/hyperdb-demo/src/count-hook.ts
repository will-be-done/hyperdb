import {
  SubscribableDB,
  deleteRows,
  selectFrom,
  upsert,
} from "@will-be-done/hyperdb";
import {
  EMPTY_TASK_STATS,
  type ProjectTaskStats,
  TASK_STATS_ID,
  type TaskStats,
  projectTaskStatsTable,
  projectsTable,
  taskStatsTable,
  tasksTable,
} from "./db";
import type { Task } from "./workload";

function applyTaskStatusDelta(
  stats: TaskStats,
  status: Task["status"],
  delta: 1 | -1,
): TaskStats {
  return {
    ...stats,
    total: stats.total + delta,
    [status]: stats[status] + delta,
  };
}

function normalizeTaskStats(stats: TaskStats): TaskStats {
  return {
    ...stats,
    projects: Math.max(0, stats.projects),
    total: Math.max(0, stats.total),
    todo: Math.max(0, stats.todo),
    doing: Math.max(0, stats.doing),
    done: Math.max(0, stats.done),
  };
}

function applyProjectTotalDelta(stats: TaskStats, delta: 1 | -1): TaskStats {
  return {
    ...stats,
    projects: stats.projects + delta,
  };
}

function applyProjectTaskCountDelta(
  stats: ProjectTaskStats,
  delta: number,
): ProjectTaskStats {
  return {
    ...stats,
    total: stats.total + delta,
  };
}
export function installTaskStatsHooks(db: SubscribableDB) {
  db.afterChange(function* updateTaskStats(_db, table, _traits, ops) {
    if (ops.length === 0) return;
    if (table !== tasksTable && table !== projectsTable) return;

    const existingStats = yield* selectFrom(taskStatsTable, "byId")
      .where((q) => q.eq("id", TASK_STATS_ID))
      .firstOr(EMPTY_TASK_STATS);

    let nextStats = existingStats;

    if (table === projectsTable) {
      for (const op of ops) {
        if (op.type === "insert" || (op.type === "upsert" && !op.oldValue)) {
          nextStats = applyProjectTotalDelta(nextStats, 1);
        } else if (op.type !== "upsert") {
          nextStats = applyProjectTotalDelta(nextStats, -1);
        }
      }

      yield* upsert(taskStatsTable, [normalizeTaskStats(nextStats)]);
      return;
    }

    if (table !== tasksTable) return;

    const projectTaskDeltas = new Map<string, number>();
    const recordProjectTaskDelta = (projectId: string, delta: 1 | -1) => {
      projectTaskDeltas.set(
        projectId,
        (projectTaskDeltas.get(projectId) ?? 0) + delta,
      );
    };

    for (const op of ops) {
      if (op.type === "insert") {
        const task = op.newValue as Task;
        nextStats = applyTaskStatusDelta(nextStats, task.status, 1);
        recordProjectTaskDelta(task.projectId, 1);
      } else if (op.type === "upsert") {
        if (op.oldValue) {
          const oldTask = op.oldValue as Task;
          nextStats = applyTaskStatusDelta(nextStats, oldTask.status, -1);
          recordProjectTaskDelta(oldTask.projectId, -1);
        }
        const newTask = op.newValue as Task;
        nextStats = applyTaskStatusDelta(nextStats, newTask.status, 1);
        recordProjectTaskDelta(newTask.projectId, 1);
      } else {
        const task = op.oldValue as Task;
        nextStats = applyTaskStatusDelta(nextStats, task.status, -1);
        recordProjectTaskDelta(task.projectId, -1);
      }
    }

    yield* upsert(taskStatsTable, [normalizeTaskStats(nextStats)]);

    const changedProjectIds = [...projectTaskDeltas.keys()];
    if (changedProjectIds.length === 0) return;

    const existingProjectTaskStats = yield* selectFrom(
      projectTaskStatsTable,
      "byId",
    ).where((q) => changedProjectIds.map((projectId) => q.eq("id", projectId)));
    const projectTaskStatsById = new Map(
      existingProjectTaskStats.map((stats) => [stats.id, stats]),
    );
    const nextProjectTaskStats: ProjectTaskStats[] = [];
    const emptyProjectStatsIds: string[] = [];

    for (const [projectId, delta] of projectTaskDeltas) {
      if (delta === 0) continue;

      const existingProjectTaskStat = projectTaskStatsById.get(projectId) ?? {
        id: projectId,
        total: 0,
      };
      const nextProjectTaskStat = applyProjectTaskCountDelta(
        existingProjectTaskStat,
        delta,
      );

      if (nextProjectTaskStat.total <= 0) {
        emptyProjectStatsIds.push(projectId);
      } else {
        nextProjectTaskStats.push(nextProjectTaskStat);
      }
    }

    if (nextProjectTaskStats.length > 0) {
      yield* upsert(projectTaskStatsTable, nextProjectTaskStats);
    }
    if (emptyProjectStatsIds.length > 0) {
      yield* deleteRows(projectTaskStatsTable, emptyProjectStatsIds);
    }
  });
}
