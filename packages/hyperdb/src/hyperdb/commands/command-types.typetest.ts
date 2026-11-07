// Compile-time checks for the yield types of selectors and actions.
// Type-checked by `pnpm ts` with the test sources; never executed.
import {
  createAction,
  createSelector,
  defineTable,
  deleteRows,
  getCurrentTraits,
  insert,
  noop,
  selectFrom,
  upsert,
  v,
  type ActionGenerator,
  type HyperDB,
  type SelectorGenerator,
} from "../index";
import { withoutUndo, type UndoManager } from "../undo";

const rows = defineTable("typetestRows", {
  id: v.string(),
  title: v.string(),
}).index("byIds", ["id"]);

const selector = createSelector();
const action = createAction();

function* readTitle(id: string): SelectorGenerator<string | undefined> {
  const row = yield* selectFrom(rows, "byId")
    .where((q) => q.eq("id", id))
    .first();
  return row?.title;
}

function* rename(id: string, title: string): ActionGenerator<void> {
  yield* upsert(rows, [{ id, title }]);
}

export const titleSelector = selector({
  name: "title",
  args: { id: v.string() },
  handler: function* ({ id }) {
    yield* noop();
    yield* getCurrentTraits();
    return yield* readTitle(id);
  },
});

export const nestedSelector = selector({
  name: "nested",
  args: { id: v.string() },
  handler: function* ({ id }) {
    return yield* titleSelector({ id });
  },
});

export const renameAction = action({
  name: "rename",
  args: { id: v.string(), title: v.string() },
  handler: function* ({ id, title }) {
    const current = yield* titleSelector({ id });
    yield* rename(id, current ?? title);
    yield* insert(rows, [{ id: `${id}-copy`, title }]);
    yield* deleteRows(rows, [id]);
    yield* withoutUndo(function* () {
      yield* rename(id, title);
    });
  },
});

export const nestedAction = action({
  name: "nestedAction",
  args: {},
  handler: function* () {
    yield* renameAction({ id: "a", title: "b" });
  },
});

export const writingSelector = selector({
  name: "writes",
  args: {},
  // @ts-expect-error selectors cannot write
  handler: function* () {
    yield* insert(rows, [{ id: "a", title: "a" }]);
  },
});

export const selectorCallingAction = selector({
  name: "callsAction",
  args: {},
  // @ts-expect-error selectors cannot run actions, which may write
  handler: function* () {
    yield* renameAction({ id: "a", title: "b" });
  },
});

export const yieldingNonCommand = action({
  name: "yieldsValue",
  args: {},
  // @ts-expect-error handlers may only yield HyperDB commands
  handler: function* () {
    yield 1;
  },
});

// @ts-expect-error helpers typed with unknown yields cannot be delegated to
export const untypedHelper: SelectorGenerator<void> = (function* (): Generator<
  unknown,
  void,
  unknown
> {})();

// Traits carry free-form fields next to `type`, as literals or interfaces.
export const tagged = (db: HyperDB) =>
  db.withTraits({ type: "myFeature.source", value: "import" });
interface SourceTrait {
  type: "myFeature.source";
  value: string;
}
export const taggedWithInterface = (db: HyperDB, trait: SourceTrait) =>
  db.withTraits(trait);

// Callback exclusions get a typed scoped DB; generator bodies keep their type.
export const callbackExclusion = (history: UndoManager) =>
  history.withoutUndo((scoped) => scoped.getId());
export const generatorExclusion = (history: UndoManager) =>
  history.withoutUndo(function* () {
    yield* rename("a", "b");
  });
export const valueExclusion = (history: UndoManager): string =>
  history.withoutUndo(() => "value");
export const untypedGeneratorExclusion = (history: UndoManager) =>
  // @ts-expect-error generator bodies must yield HyperDB commands
  history.withoutUndo(function* (): Generator<unknown, void, unknown> {});
