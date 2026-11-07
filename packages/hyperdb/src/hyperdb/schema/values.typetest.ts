// Compile-time checks for validator input and output types.
// Type-checked by `pnpm ts` with the test sources; never executed.
import {
  createAction,
  defineTable,
  insert,
  upsert,
  v,
  type ExtractSchema,
  type ExtractSchemaInput,
  type HyperDB,
  type Infer,
  type InferInput,
} from "../index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const expectType = <T extends true>(_value: T) => {};

export const bytes = v.arrayBuffer();
expectType<Equal<Infer<typeof bytes>, ArrayBuffer>>(true);
expectType<Equal<InferInput<typeof bytes>, ArrayBuffer | ArrayBufferView>>(
  true,
);
expectType<Equal<InferInput<ReturnType<typeof v.string>>, string>>(true);

const composite = v.object({
  id: v.string(),
  list: v.array(v.arrayBuffer()),
  maybe: v.optional(v.arrayBuffer()),
  either: v.union(v.arrayBuffer(), v.null()),
  byKey: v.record(v.string(), v.arrayBuffer()),
  later: v.lazy(() => v.arrayBuffer()),
});
type CompositeIn = InferInput<typeof composite>;
type CompositeOut = Infer<typeof composite>;
expectType<Equal<CompositeOut["list"], ArrayBuffer[]>>(true);
expectType<Equal<CompositeIn["list"], (ArrayBuffer | ArrayBufferView)[]>>(true);
expectType<Equal<CompositeOut["maybe"], ArrayBuffer | undefined>>(true);
expectType<
  Equal<CompositeIn["maybe"], ArrayBuffer | ArrayBufferView | undefined>
>(true);
expectType<Equal<CompositeIn["either"], ArrayBuffer | ArrayBufferView | null>>(
  true,
);
expectType<
  Equal<CompositeIn["byKey"], Record<string, ArrayBuffer | ArrayBufferView>>
>(true);
expectType<Equal<CompositeIn["later"], ArrayBuffer | ArrayBufferView>>(true);

export const partial = v.partial(composite);
expectType<
  Equal<
    InferInput<typeof partial>["list"],
    (ArrayBuffer | ArrayBufferView)[] | undefined
  >
>(true);
export const required = v.required(composite, ["maybe"]);
expectType<
  Equal<InferInput<typeof required>["maybe"], ArrayBuffer | ArrayBufferView>
>(true);

const files = defineTable("typetestFiles", {
  id: v.string(),
  data: v.arrayBuffer(),
});
expectType<Equal<ExtractSchema<typeof files>["data"], ArrayBuffer>>(true);
expectType<
  Equal<ExtractSchemaInput<typeof files>["data"], ArrayBuffer | ArrayBufferView>
>(true);

// Writes accept typed arrays without a cast; reads produce ArrayBuffer.
const standaloneFiles = defineTable(
  "typetestStandaloneFiles",
  v.object({ id: v.string(), data: v.arrayBuffer() }),
).index("byData", ["data"]);
export const saveFile = createAction()({
  name: "saveFile",
  args: { id: v.string() },
  handler: function* ({ id }) {
    yield* insert(files, [{ id, data: new Uint8Array([1]) }]);
    yield* upsert(standaloneFiles, [
      { id, data: new DataView(new ArrayBuffer(1)) },
    ]);
  },
});

export function* writeDirect(db: HyperDB) {
  yield* db.insert(files, [{ id: "a", data: new Uint8Array([1]) }]);
  const rows = yield* db.intervalScan(files, "byId", [
    { eq: [{ col: "id", val: "a" }] },
  ]);
  const data: ArrayBuffer | undefined = rows[0]?.data;
  return data;
}

// @ts-expect-error a string is not binary input
export const badWrite = insert(files, [{ id: "a", data: "bytes" }]);
