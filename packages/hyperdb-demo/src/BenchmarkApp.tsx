import {
  useAsyncDispatch as useHyperdbDispatch,
  useAsyncSelector,
} from "@will-be-done/hyperdb/react";
import {
  clearWorkload,
  EMPTY_DASHBOARD_SNAPSHOT,
  generateWorkload,
  getDashboardSnapshot,
  toggleTaskDone,
} from "./db";
import { LIST_PAGE_SIZE, useBenchmarkState } from "./useBenchmarkState";
import type { ClearWorkloadResult, WorkloadResult } from "./workload";
import { getStoredMode, setStoredMode, type StoreMode } from "./store-mode";
import { usePersistence } from "./persistence-context";

const numberFormatter = new Intl.NumberFormat("en-US");
const durationFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatDuration(value: number) {
  return durationFormatter.format(value);
}

function clampInteger(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;

  return Math.max(0, Math.floor(value));
}

const LABEL =
  "font-display text-[10px] font-semibold uppercase tracking-[0.18em] text-faint";

const STATUS_STYLES: Record<string, string> = {
  done: "border-green/40 bg-green/10 text-green",
  doing: "border-amber/40 bg-amber/10 text-amber",
  todo: "border-line bg-panel-2 text-muted",
};

export function BenchmarkApp() {
  const dispatch = useHyperdbDispatch();
  const benchmarkState = useBenchmarkState();
  const {
    projectCount,
    setProjectCount,
    tasksPerProject,
    setTasksPerProject,
    taskLimit,
    setTaskLimit,
    projectLimit,
    setProjectLimit,
    setSelectedProjectId,
    lastRun,
    setLastRun,
    isWorking,
    setIsWorking,
  } = benchmarkState;
  const dashboard =
    useAsyncSelector({
      selector: getDashboardSnapshot,
      args: {
        taskLimit,
        projectLimit,
        selectedProjectId: benchmarkState.selectedProjectId,
      },
    }) ?? EMPTY_DASHBOARD_SNAPSHOT;

  const storeMode = getStoredMode();
  const persistence = usePersistence();
  const handleStoreModeChange = (
    event: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const nextMode = event.currentTarget.value as StoreMode;
    if (nextMode === storeMode) return;
    // The store is created once at startup, so swapping tiers means a reload.
    // The choice is remembered in localStorage and applied on the next boot.
    setStoredMode(nextMode);
    window.location.reload();
  };

  const queuedTasks = projectCount * tasksPerProject;
  const visibleTaskCount = dashboard.selectedProject
    ? Math.min(taskLimit, dashboard.selectedTaskCount)
    : 0;
  const visibleProjectCount = Math.min(projectLimit, dashboard.totalProjects);
  const directDriver =
    storeMode === "idb" || storeMode === "idb-inmem"
      ? "IndexedDB"
      : "WA-SQLite OPFS";
  const hybrid = storeMode === "idb-inmem" || storeMode === "wa-sqlite-inmem";
  const storageStatus = hybrid
    ? {
        dot:
          persistence?.draining || persistence?.pendingBatches
            ? "animate-blip bg-amber"
            : "bg-green",
        text:
          persistence?.draining || persistence?.pendingBatches
            ? `Saving... ${formatNumber(persistence.pendingOps)} ops queued`
            : persistence?.lastDurationMs != null
              ? `Saved ${formatNumber(
                  persistence.lastOpCount ?? 0,
                )} ops in ${formatDuration(persistence.lastDurationMs)} ms`
              : `${directDriver} mirrored behind in-memory reads/writes.`,
      }
    : {
        dot: "bg-green",
        text: `Direct async ${directDriver} driver; changes survive reloads.`,
      };

  const runMeasured = (
    label: string,
    workload: () => Promise<WorkloadResult | ClearWorkloadResult>,
  ) => {
    setIsWorking(true);

    requestAnimationFrame(() => {
      void (async () => {
        const startedAt = performance.now();
        try {
          const result = await workload();
          const durationMs = performance.now() - startedAt;

          setLastRun({ label, durationMs, result });
        } catch (error) {
          console.error(`Failed to run ${label}`, error);
        } finally {
          setIsWorking(false);
        }
      })();
    });
  };

  const runCustomWorkload = () => {
    runMeasured("custom batch", () =>
      dispatch(generateWorkload({ projectCount, tasksPerProject })),
    );
  };

  const runTenThousandTasks = () => {
    runMeasured("100,000 task batch", () =>
      dispatch(generateWorkload({ projectCount: 20, tasksPerProject: 5000 })),
    );
  };

  const clearAll = () => {
    setSelectedProjectId(null);
    setTaskLimit(LIST_PAGE_SIZE);
    setProjectLimit(LIST_PAGE_SIZE);
    runMeasured("clear", () => dispatch(clearWorkload({})));
  };

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setTaskLimit(LIST_PAGE_SIZE);
  };

  const metrics = [
    { label: "Projects", value: dashboard.totalProjects, accent: "text-ink" },
    { label: "Tasks", value: dashboard.totalTasks, accent: "text-signal" },
    { label: "Doing", value: dashboard.doingTasks, accent: "text-amber" },
    { label: "Done", value: dashboard.doneTasks, accent: "text-green" },
  ];

  return (
    <main className="mx-auto w-[min(1320px,100%-2rem)] animate-rise py-7 pb-32">
      {/* ── Header / live status readout ─────────────────────────── */}
      <header className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel/80 backdrop-blur sm:flex-row sm:items-stretch sm:justify-between">
        <div className="flex flex-col justify-center gap-2 p-6">
          <p className={LABEL}>HyperDB</p>
          <h1 className="font-display text-3xl font-bold leading-none tracking-tight text-ink sm:text-4xl">
            Project / task demo example
          </h1>
        </div>

        <div className="flex min-w-[200px] flex-col justify-center gap-2 border-t border-line bg-base/60 p-6 text-left sm:border-l sm:border-t-0">
          <span className={LABEL}>Driver</span>
          <select
            value={storeMode}
            onChange={handleStoreModeChange}
            className="h-10 w-full cursor-pointer rounded-md border border-line bg-base px-3 font-mono text-sm text-ink outline-none transition focus-visible:border-signal/60 focus-visible:ring-2 focus-visible:ring-signal/20"
          >
            <option value="idb">IndexedDB</option>
            <option value="idb-inmem">IndexedDB + in-memory</option>
            <option value="wa-sqlite">WA-SQLite OPFS</option>
            <option value="wa-sqlite-inmem">WA-SQLite OPFS + in-memory</option>
          </select>
          <div className="flex items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${storageStatus.dot}`}
            />
            <p className="text-xs text-faint">{storageStatus.text}</p>
          </div>
        </div>

        <div className="relative flex min-w-[220px] flex-col justify-center gap-2 border-t border-line bg-base/60 p-6 text-left sm:border-l sm:border-t-0 sm:text-right">
          <div className="flex items-center gap-2 sm:justify-end">
            <span
              className={`size-2 rounded-full ${
                isWorking ? "animate-blip bg-signal" : "bg-faint"
              }`}
            />
            <span className={LABEL}>{isWorking ? "Running" : "Idle"}</span>
          </div>
          <div className="readout text-4xl font-medium text-ink">
            {lastRun ? formatDuration(lastRun.durationMs) : "—"}
            {lastRun ? (
              <span className="ml-1 text-base text-faint">ms</span>
            ) : null}
          </div>
          {isWorking ? (
            <div className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
              <div className="h-full w-1/3 animate-sweep bg-signal" />
            </div>
          ) : null}
        </div>
      </header>

      {/* ── Controls ─────────────────────────────────────────────── */}
      <section
        aria-label="Workload controls"
        className="mt-3 grid grid-cols-1 items-end gap-4 rounded-xl border border-line bg-panel/80 p-5 backdrop-blur md:grid-cols-[repeat(3,minmax(0,1fr))_auto]"
      >
        <label className="flex flex-col gap-2">
          <span className={LABEL}>Projects</span>
          <input
            min="1"
            step="1"
            type="number"
            value={projectCount}
            onChange={(event) =>
              setProjectCount(
                clampInteger(event.currentTarget.valueAsNumber, 1),
              )
            }
            className="h-10 w-full rounded-md border border-line bg-base px-3 font-mono tabular-nums text-ink outline-none transition focus-visible:border-signal/60 focus-visible:ring-2 focus-visible:ring-signal/20"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className={LABEL}>Tasks / project</span>
          <input
            min="0"
            step="1"
            type="number"
            value={tasksPerProject}
            onChange={(event) =>
              setTasksPerProject(
                clampInteger(event.currentTarget.valueAsNumber, 0),
              )
            }
            className="h-10 w-full rounded-md border border-line bg-base px-3 font-mono tabular-nums text-ink outline-none transition focus-visible:border-signal/60 focus-visible:ring-2 focus-visible:ring-signal/20"
          />
        </label>

        <div className="flex flex-col justify-center gap-1 rounded-md border border-dashed border-line bg-base/40 px-4 py-2">
          <span className={LABEL}>Queued rows</span>
          <strong className="readout text-2xl font-medium text-signal">
            {formatNumber(projectCount + queuedTasks)}
          </strong>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runCustomWorkload}
            disabled={isWorking}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-signal/50 bg-signal/15 px-4 font-display text-xs font-semibold uppercase tracking-wider text-signal transition hover:not-disabled:-translate-y-px hover:not-disabled:border-signal hover:not-disabled:shadow-[0_0_24px_-8px] hover:not-disabled:shadow-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Generate batch
          </button>
          <button
            type="button"
            onClick={runTenThousandTasks}
            disabled={isWorking}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-line bg-panel-2 px-4 font-display text-xs font-semibold uppercase tracking-wider text-ink transition hover:not-disabled:-translate-y-px hover:not-disabled:border-ink/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Spike 100k
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={
              isWorking || dashboard.totalTasks + dashboard.totalProjects === 0
            }
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-danger/40 bg-panel-2 px-4 font-display text-xs font-semibold uppercase tracking-wider text-danger transition hover:not-disabled:-translate-y-px hover:not-disabled:border-danger hover:not-disabled:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </section>

      {/* ── Metrics ──────────────────────────────────────────────── */}
      <section
        aria-label="Database metrics"
        className="mt-3 grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel/80 backdrop-blur lg:grid-cols-4"
      >
        {metrics.map((metric, index) => (
          <article
            key={metric.label}
            className={`flex flex-col gap-2 p-6 ${
              index % 2 === 1 ? "border-l border-line" : ""
            } ${index >= 2 ? "border-t border-line lg:border-t-0" : ""} ${
              index > 0 ? "lg:border-l lg:border-line" : ""
            }`}
          >
            <span className={LABEL}>{metric.label}</span>
            <strong
              className={`readout text-4xl font-medium leading-none ${metric.accent}`}
            >
              {formatNumber(metric.value)}
            </strong>
          </article>
        ))}
      </section>

      {/* ── Last run console ─────────────────────────────────────── */}
      {lastRun ? (
        <section
          aria-label="Last run"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel/80 px-5 py-3 backdrop-blur"
        >
          <span className="font-display text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
            ▸ {lastRun.label}
          </span>
          <span className="readout text-sm font-medium text-ink">
            {formatDuration(lastRun.durationMs)} ms
          </span>
          <code className="min-w-0 flex-1 truncate rounded border border-line bg-base px-2 py-1 font-mono text-xs text-muted">
            {JSON.stringify(lastRun.result)}
          </code>
        </section>
      ) : null}

      {/* ── Data panels ──────────────────────────────────────────── */}
      <section className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        {/* Tasks */}
        <div className="overflow-hidden rounded-xl border border-line bg-panel/80 backdrop-blur">
          <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-line px-5">
            <h2 className="font-display text-base font-semibold text-ink">
              {dashboard.selectedProject
                ? `${formatNumber(visibleTaskCount)} of ${formatNumber(
                    dashboard.selectedTaskCount,
                  )} tasks`
                : "Project tasks"}
            </h2>
            <span className={LABEL}>
              {dashboard.selectedProject?.name ?? "Select a project"}
            </span>
          </div>

          <div className="flex flex-col">
            {dashboard.selectedTasks.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted">
                {dashboard.selectedProject
                  ? "No tasks in this project."
                  : "No project selected."}
              </p>
            ) : (
              dashboard.selectedTasks.map((task) => (
                <article
                  key={task.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line-soft px-5 py-2.5 transition hover:bg-panel-2"
                >
                  <div className="min-w-0">
                    <strong className="block truncate text-sm font-medium text-ink">
                      {task.title}
                    </strong>
                    <span className="block truncate text-xs text-faint">
                      {dashboard.selectedProject?.name ??
                        dashboard.projectNamesById[task.projectId] ??
                        task.projectId}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void dispatch(toggleTaskDone({ task }))}
                    className={`cursor-pointer rounded-full border px-3 py-0.5 font-display text-[10px] font-semibold uppercase tracking-wider transition hover:brightness-125 ${
                      STATUS_STYLES[task.status] ?? STATUS_STYLES.todo
                    }`}
                  >
                    {task.status}
                  </button>
                  <span className="readout w-9 text-right text-xs text-faint">
                    p{task.priority}
                  </span>
                </article>
              ))
            )}
            {dashboard.selectedTasks.length < dashboard.selectedTaskCount ? (
              <div className="flex justify-center border-b border-line-soft px-5 py-3">
                <button
                  type="button"
                  onClick={() =>
                    setTaskLimit((limit) => limit + LIST_PAGE_SIZE)
                  }
                  className="inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-panel-2 px-5 font-display text-[11px] font-semibold uppercase tracking-wider text-muted transition hover:-translate-y-px hover:border-ink/30 hover:text-ink"
                >
                  Show more
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Projects */}
        <div className="overflow-hidden rounded-xl border border-line bg-panel/80 backdrop-blur">
          <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-line px-5">
            <h2 className="font-display text-base font-semibold text-ink">
              First {formatNumber(visibleProjectCount || LIST_PAGE_SIZE)}{" "}
              projects
            </h2>
            <span className={LABEL}>
              {formatNumber(dashboard.totalProjects)} total
            </span>
          </div>

          <div className="flex flex-col">
            {dashboard.projects.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted">
                No projects loaded.
              </p>
            ) : (
              dashboard.projects.map((project) => {
                const selected = project.id === dashboard.selectedProject?.id;

                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => selectProject(project.id)}
                    className={`relative grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-soft px-5 py-3 text-left transition hover:bg-panel-2 ${
                      selected ? "bg-signal/[0.07]" : ""
                    }`}
                  >
                    {selected ? (
                      <span className="absolute inset-y-0 left-0 w-[3px] bg-signal" />
                    ) : null}
                    <span
                      className="h-8 w-[14px] rounded-sm"
                      style={{ backgroundColor: project.color }}
                    />
                    <strong
                      className={`truncate text-sm font-medium ${
                        selected ? "text-ink" : "text-muted"
                      }`}
                    >
                      {project.name}
                    </strong>
                    <span className="readout text-xs text-faint">
                      {formatNumber(
                        dashboard.projectTaskCountsById[project.id] ?? 0,
                      )}{" "}
                      tasks
                    </span>
                  </button>
                );
              })
            )}
            {dashboard.projects.length < dashboard.totalProjects ? (
              <div className="flex justify-center border-b border-line-soft px-5 py-3">
                <button
                  type="button"
                  onClick={() =>
                    setProjectLimit((limit) => limit + LIST_PAGE_SIZE)
                  }
                  className="inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-panel-2 px-5 font-display text-[11px] font-semibold uppercase tracking-wider text-muted transition hover:-translate-y-px hover:border-ink/30 hover:text-ink"
                >
                  Show more
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
