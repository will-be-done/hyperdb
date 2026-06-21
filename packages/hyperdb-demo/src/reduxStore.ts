import {
  combineReducers,
  createStore,
  type Dispatch,
  type UnknownAction,
} from "redux";
import { useDispatch, useSelector } from "react-redux";
import {
  createWorkloadRows,
  type ClearWorkloadResult,
  type DashboardSnapshot,
  type Project,
  type Task,
  type WorkloadResult,
} from "./workload";

type ReduxWorkloadState = {
  projects: Project[];
  tasks: Task[];
  projectTaskCountsById: Record<string, number>;
  stats: {
    totalTasks: number;
    todoTasks: number;
    doingTasks: number;
    doneTasks: number;
  };
};

const initialState: ReduxWorkloadState = {
  projects: [],
  tasks: [],
  projectTaskCountsById: {},
  stats: {
    totalTasks: 0,
    todoTasks: 0,
    doingTasks: 0,
    doneTasks: 0,
  },
};

const ARRAY_PUSH_BATCH_SIZE = 8_192;

function pushInBatches<T>(target: T[], items: readonly T[]) {
  for (let index = 0; index < items.length; index += ARRAY_PUSH_BATCH_SIZE) {
    target.push(...items.slice(index, index + ARRAY_PUSH_BATCH_SIZE));
  }
}

function getTaskStatsDelta(tasks: Task[], delta: 1 | -1) {
  const stats = {
    totalTasks: tasks.length * delta,
    todoTasks: 0,
    doingTasks: 0,
    doneTasks: 0,
  };

  for (const task of tasks) {
    if (task.status === "todo") {
      stats.todoTasks += delta;
    } else if (task.status === "doing") {
      stats.doingTasks += delta;
    } else {
      stats.doneTasks += delta;
    }
  }

  return stats;
}

function addStats(
  left: ReduxWorkloadState["stats"],
  right: ReduxWorkloadState["stats"],
): ReduxWorkloadState["stats"] {
  return {
    totalTasks: left.totalTasks + right.totalTasks,
    todoTasks: left.todoTasks + right.todoTasks,
    doingTasks: left.doingTasks + right.doingTasks,
    doneTasks: left.doneTasks + right.doneTasks,
  };
}

const GENERATE_REDUX_WORKLOAD = "reduxWorkload/generateReduxWorkload";
const CLEAR_REDUX_WORKLOAD = "reduxWorkload/clearReduxWorkload";
const TOGGLE_REDUX_TASK_DONE = "reduxWorkload/toggleReduxTaskDone";

type GenerateReduxWorkloadAction = {
  type: typeof GENERATE_REDUX_WORKLOAD;
  payload: {
    projects: Project[];
    tasks: Task[];
    result: WorkloadResult;
  };
};

type ClearReduxWorkloadAction = {
  type: typeof CLEAR_REDUX_WORKLOAD;
  payload: ClearWorkloadResult;
};

type ToggleReduxTaskDoneAction = {
  type: typeof TOGGLE_REDUX_TASK_DONE;
  payload: string;
};

type ReduxWorkloadAction =
  | GenerateReduxWorkloadAction
  | ClearReduxWorkloadAction
  | ToggleReduxTaskDoneAction;

export function generateReduxWorkload(payload: {
  projectCount: number;
  tasksPerProject: number;
}): GenerateReduxWorkloadAction {
  const rows = createWorkloadRows(payload.projectCount, payload.tasksPerProject);

  return {
    type: GENERATE_REDUX_WORKLOAD,
    payload: {
      projects: rows.projects,
      tasks: rows.tasks,
      result: rows.result,
    },
  };
}

export function clearReduxWorkload(
  payload: ClearWorkloadResult,
): ClearReduxWorkloadAction {
  return {
    type: CLEAR_REDUX_WORKLOAD,
    payload,
  };
}

export function toggleReduxTaskDone(
  payload: string,
): ToggleReduxTaskDoneAction {
  return {
    type: TOGGLE_REDUX_TASK_DONE,
    payload,
  };
}

function isReduxWorkloadAction(
  action: UnknownAction,
): action is ReduxWorkloadAction {
  return (
    action.type === GENERATE_REDUX_WORKLOAD ||
    action.type === CLEAR_REDUX_WORKLOAD ||
    action.type === TOGGLE_REDUX_TASK_DONE
  );
}

function reduxWorkloadReducer(
  state: ReduxWorkloadState = initialState,
  action: UnknownAction,
): ReduxWorkloadState {
  if (!isReduxWorkloadAction(action)) return state;

  if (action.type === GENERATE_REDUX_WORKLOAD) {
    const projects = state.projects.slice();
    const tasks = state.tasks.slice();
    const projectTaskCountsById = { ...state.projectTaskCountsById };
    const statsDelta = getTaskStatsDelta(action.payload.tasks, 1);

    pushInBatches(projects, action.payload.projects);
    pushInBatches(tasks, action.payload.tasks);

    for (const task of action.payload.tasks) {
      projectTaskCountsById[task.projectId] =
        (projectTaskCountsById[task.projectId] ?? 0) + 1;
    }

    return {
      projects,
      tasks,
      projectTaskCountsById,
      stats: addStats(state.stats, statsDelta),
    };
  }

  if (action.type === CLEAR_REDUX_WORKLOAD) {
    return initialState;
  }

  if (action.type === TOGGLE_REDUX_TASK_DONE) {
    const taskIndex = state.tasks.findIndex(
      (item) => item.id === action.payload,
    );

    if (taskIndex === -1) return state;

    const task = state.tasks[taskIndex];
    const nextStatus: Task["status"] = task.status === "done" ? "todo" : "done";
    const nextTasks = state.tasks.slice();
    const statsDelta = getTaskStatsDelta([task], -1);
    const nextTask: Task = { ...task, status: nextStatus };

    nextTasks[taskIndex] = nextTask;

    return {
      ...state,
      tasks: nextTasks,
      stats: addStats(
        addStats(state.stats, statsDelta),
        getTaskStatsDelta([nextTask], 1),
      ),
    };
  }

  return state;
}

const rootReducer = combineReducers({
  reduxWorkload: reduxWorkloadReducer,
});

export const reduxStore = createStore(rootReducer);

export type ReduxRootState = ReturnType<typeof reduxStore.getState>;
export interface ReduxAppDispatch extends Dispatch<UnknownAction> {
  (action: GenerateReduxWorkloadAction): GenerateReduxWorkloadAction;
  (action: ClearReduxWorkloadAction): ClearReduxWorkloadAction;
  (action: ToggleReduxTaskDoneAction): ToggleReduxTaskDoneAction;
}

export const useReduxAppDispatch = useDispatch.withTypes<ReduxAppDispatch>();
export const useReduxAppSelector = useSelector.withTypes<ReduxRootState>();

export function selectReduxDashboardSnapshot(
  state: ReduxRootState,
  taskLimit = 10,
  projectLimit = 10,
  selectedProjectId: string | null = null,
): DashboardSnapshot {
  const projects = state.reduxWorkload.projects.slice(0, projectLimit);
  const selectedProject = selectedProjectId
    ? (state.reduxWorkload.projects.find(
        (project) => project.id === selectedProjectId,
      ) ?? null)
    : (projects[0] ?? null);
  const selectedTasks = selectedProject
    ? state.reduxWorkload.tasks
        .filter((task) => task.projectId === selectedProject.id)
        .sort((left, right) => left.position - right.position)
        .slice(0, taskLimit)
    : [];
  const projectNamesById = Object.fromEntries(
    projects.map((project) => [project.id, project.name]),
  );

  return {
    projects,
    selectedProject,
    selectedTasks,
    selectedTaskCount: selectedProject
      ? (state.reduxWorkload.projectTaskCountsById[selectedProject.id] ?? 0)
      : 0,
    projectTaskCountsById: Object.fromEntries(
      projects.map((project) => [
        project.id,
        state.reduxWorkload.projectTaskCountsById[project.id] ?? 0,
      ]),
    ),
    projectNamesById,
    totalProjects: state.reduxWorkload.projects.length,
    totalTasks: state.reduxWorkload.stats.totalTasks,
    todoTasks: state.reduxWorkload.stats.todoTasks,
    doingTasks: state.reduxWorkload.stats.doingTasks,
    doneTasks: state.reduxWorkload.stats.doneTasks,
  };
}
