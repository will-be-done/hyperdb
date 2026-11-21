import {
  Component,
  Suspense,
  act,
  useDeferredValue,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, execSync } from "../hyperdb/db";
import { BptreeInmemDriver } from "../hyperdb/drivers/inmemory/bptree-inmem-driver";
import { unwrap } from "../hyperdb/commands/async";
import { selectFrom } from "../hyperdb/commands/selector/builder";
import { createSelector } from "../hyperdb/commands/selector/selector";
import { SubscribableDB } from "../hyperdb/runtime/subscribable-db";
import { defineTable } from "../hyperdb/schema/table";
import { v } from "../hyperdb/schema/values";
import { DBProvider } from "./context";
import { useSuspenseSelector } from "./hooks";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const selector = createSelector();

const tasksTable = defineTable("suspenseTasks", {
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
}).index("byProject", ["projectId"]);

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A gated project reads like cold storage: its next run waits for the gate.
let gates: Map<string, ReturnType<typeof deferred>>;
let runs: string[];

const projectTitles = selector({
  name: "suspenseProjectTitles",
  args: { projectId: v.string() },
  *handler({ projectId }) {
    runs.push(projectId);
    const gate = gates.get(projectId);
    if (gate) yield* unwrap(gate.promise);
    const tasks = yield* selectFrom(tasksTable, "byProject").where((q) =>
      q.eq("projectId", projectId),
    );
    return tasks.map((task) => task.title).join(",");
  },
});

const gate = (projectId: string) => {
  const next = deferred();
  gates.set(projectId, next);
  return () =>
    act(async () => {
      gates.delete(projectId);
      next.resolve();
      await next.promise;
    });
};

const failingGate = (projectId: string) => {
  const next = deferred();
  gates.set(projectId, next);
  return () =>
    act(async () => {
      gates.delete(projectId);
      next.reject(new Error(`${projectId} failed`));
      await next.promise.catch(() => undefined);
    });
};

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? `error: ${this.state.error.message}`
      : this.props.children;
  }
}

function Titles({ projectId }: { projectId: string }) {
  return (
    <span>
      {useSuspenseSelector({ selector: projectTitles, args: { projectId } })}
    </span>
  );
}

let db: SubscribableDB;
let container: HTMLDivElement;
let root: Root;

const render = (children: React.ReactNode) =>
  act(async () => {
    root.render(
      <DBProvider value={db}>
        <Suspense fallback="loading">{children}</Suspense>
      </DBProvider>,
    );
  });

const insertTask = (id: string, projectId: string, title: string) =>
  act(async () => {
    execSync(db.insert(tasksTable, [{ id, projectId, title }]));
  });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  gates = new Map();
  runs = [];
  db = new SubscribableDB(new DB(new BptreeInmemDriver()));
  execSync(db.loadTables([tasksTable]));
  execSync(
    db.insert(tasksTable, [
      { id: "a1", projectId: "a", title: "A1" },
      { id: "b1", projectId: "b", title: "B1" },
    ]),
  );
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useSuspenseSelector", () => {
  it("renders a synchronous result without suspending", async () => {
    await render(<Titles projectId="a" />);

    expect(container.textContent).toBe("A1");
  });

  it("suspends until the first read settles and runs it once across retries", async () => {
    const consoleError = vi.spyOn(console, "error");
    const open = gate("a");

    await render(<Titles projectId="a" />);
    expect(container.textContent).toBe("loading");

    await open();
    expect(container.textContent).toBe("A1");
    expect(runs).toEqual(["a"]);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns each read's own result when one component suspends on two", async () => {
    function Both() {
      const a = useSuspenseSelector({
        selector: projectTitles,
        args: { projectId: "a" },
      });
      const b = useSuspenseSelector({
        selector: projectTitles,
        args: { projectId: "b" },
      });
      return `${a}|${b}`;
    }
    const openA = gate("a");
    const openB = gate("b");

    await render(<Both />);
    await openA();
    expect(container.textContent).toBe("loading");

    await openB();
    expect(container.textContent).toBe("A1|B1");
  });

  it("throws a failed first read to the error boundary instead of reading again", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fail = failingGate("a");

    await render(
      <ErrorBoundary>
        <Titles projectId="a" />
      </ErrorBoundary>,
    );
    expect(container.textContent).toBe("loading");

    await fail();
    expect(container.textContent).toBe("error: a failed");
    expect(runs).toEqual(["a"]);
    consoleError.mockRestore();
  });

  it("keeps the shown result while a database change reruns the selector", async () => {
    await render(<Titles projectId="a" />);
    const open = gate("a");

    await insertTask("a2", "a", "A2");
    expect(container.textContent).toBe("A1");

    await open();
    expect(container.textContent).toBe("A1,A2");
  });

  it("keeps the previous args on screen when they change through a deferred value", async () => {
    let show!: (projectId: string) => void;
    function Picker() {
      const [projectId, setProjectId] = useState("a");
      show = setProjectId;
      return <Titles projectId={useDeferredValue(projectId)} />;
    }
    await render(<Picker />);
    const open = gate("b");

    await act(async () => show("b"));
    expect(container.textContent).toBe("A1");

    await open();
    expect(container.textContent).toBe("B1");
  });

  it("rejects selectors without root memoization", async () => {
    const uncached = selector({
      name: "suspenseUncached",
      args: {},
      memoization: { root: false },
      *handler() {
        return "never";
      },
    });
    function Uncached() {
      return <>{useSuspenseSelector({ selector: uncached, args: {} })}</>;
    }
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(render(<Uncached />)).rejects.toThrow(
      "useSuspenseSelector needs a selector with root memoization enabled",
    );
    consoleError.mockRestore();
  });
});
