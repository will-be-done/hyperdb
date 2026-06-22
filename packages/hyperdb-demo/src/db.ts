import {
  createAction,
  defineTable,
  deleteRows,
  createSelector,
  insert,
  selectFrom,
  upsert,
  v,
} from "@will-be-done/hyperdb";
import { createWorkloadRows, type DashboardSnapshot } from "./workload";
import type { ExtractSchema } from "@will-be-done/hyperdb";

const action = createAction({
  trace: {
    enabled: true,
    startOn: "load",
  },
});
const selector = createSelector({
  trace: {
    enabled: true,
    startOn: "load",
  },
});

export const projectsTable = defineTable("projects", {
  id: v.string(),
  name: v.string(),
  color: v.string(),
  createdAt: v.number(),
})
  .index("byCreatedAt", ["createdAt"])
  .index("byName", ["name"])
  .index("byIds", ["id"]); // btree over id → enables a full-table scan for hydration
export type Project = ExtractSchema<typeof projectsTable>;

export const tasksTable = defineTable("tasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")),
  priority: v.number(),
  position: v.number(),
  createdAt: v.number(),
  estimate: v.number(),
})
  .index("byCreatedAt", ["createdAt"])
  .index("byProjectPosition", ["projectId", "position"])
  .index("byStatus", ["status"])
  .index("byIds", ["id"]); // btree over id → enables a full-table scan for hydration
export type Task = ExtractSchema<typeof tasksTable>;
export type TaskStatus = Task["status"];

export const taskStatsTable = defineTable("taskStats", {
  id: v.string(),
  projects: v.number(),
  total: v.number(),
  todo: v.number(),
  doing: v.number(),
  done: v.number(),
});
export type TaskStats = ExtractSchema<typeof taskStatsTable>;

export const projectTaskStatsTable = defineTable("projectTaskStats", {
  id: v.string(),
  total: v.number(),
});
export type ProjectTaskStats = ExtractSchema<typeof projectTaskStatsTable>;

export const generateWorkload = action({
  name: "generateWorkload",
  args: {
    projectCount: v.number(),
    tasksPerProject: v.number(),
  },
  handler: function* generateWorkload({ projectCount, tasksPerProject }) {
    const { projects, tasks, result } = createWorkloadRows(
      projectCount,
      tasksPerProject,
    );

    yield* insert(projectsTable, projects);
    yield* insert(tasksTable, tasks);
    yield* getDashboardSnapshot({
      taskLimit: 10,
      projectLimit: 10,
      selectedProjectId: null,
    });

    return result;
  },
});

export const clearWorkload = action({
  name: "clearWorkload",
  args: {},
  handler: function* clearWorkload() {
    const projects = yield* selectFrom(projectsTable, "byCreatedAt").where(
      (q) => q,
    );
    const tasks = yield* selectFrom(tasksTable, "byCreatedAt").where((q) => q);

    yield* deleteRows(
      tasksTable,
      tasks.map((task) => task.id),
    );
    yield* deleteRows(
      projectsTable,
      projects.map((project) => project.id),
    );

    return {
      projectsDeleted: projects.length,
      tasksDeleted: tasks.length,
    };
  },
});

export const toggleTaskDone = action({
  name: "toggleTaskDone",
  args: {
    task: tasksTable.v(),
  },
  handler: function* toggleTaskDone({ task }: { task: Task }) {
    const status: Task["status"] = task.status === "done" ? "todo" : "done";

    yield* upsert(tasksTable, [{ ...task, status }]);

    return status;
  },
});

export const TASK_STATS_ID = "tasks";
export const EMPTY_TASK_STATS: TaskStats = {
  id: TASK_STATS_ID,
  projects: 0,
  total: 0,
  todo: 0,
  doing: 0,
  done: 0,
};

export const getDashboardSnapshot = selector({
  name: "getDashboardSnapshot",
  args: {
    taskLimit: v.number(),
    projectLimit: v.number(),
    selectedProjectId: v.union(v.string(), v.null()),
  },
  handler: function* getDashboardSnapshot({
    taskLimit,
    projectLimit,
    selectedProjectId,
  }) {
    const projects = yield* selectFrom(projectsTable, "byCreatedAt")
      .where((q) => q)
      .order("asc")
      .limit(projectLimit);

    const selectedProject = selectedProjectId
      ? yield* selectFrom(projectsTable, "byId")
          .where((q) => q.eq("id", selectedProjectId))
          .firstOr(null)
      : (projects[0] ?? null);
    const visibleProjectTaskStats =
      projects.length > 0
        ? yield* selectFrom(projectTaskStatsTable, "byId").where((q) =>
            projects.map((project) => q.eq("id", project.id)),
          )
        : [];
    const selectedProjectTaskStats = selectedProject
      ? yield* selectFrom(projectTaskStatsTable, "byId")
          .where((q) => q.eq("id", selectedProject.id))
          .firstOr(null)
      : null;
    const selectedTasks = selectedProject
      ? yield* selectFrom(tasksTable, "byProjectPosition")
          .where((q) => q.eq("projectId", selectedProject.id))
          .order("asc")
          .limit(taskLimit)
      : [];
    const stats = yield* selectFrom(taskStatsTable, "byId")
      .where((q) => q.eq("id", TASK_STATS_ID))
      .firstOr(EMPTY_TASK_STATS);

    return {
      projects,
      selectedProject,
      selectedTasks,
      selectedTaskCount: selectedProjectTaskStats?.total ?? 0,
      projectTaskCountsById: Object.fromEntries(
        visibleProjectTaskStats.map((stats) => [stats.id, stats.total]),
      ),
      projectNamesById: Object.fromEntries(
        projects.map((project) => [project.id, project.name]),
      ),
      totalProjects: stats.projects,
      totalTasks: stats.total,
      todoTasks: stats.todo,
      doingTasks: stats.doing,
      doneTasks: stats.done,
    } satisfies DashboardSnapshot;
  },
});
