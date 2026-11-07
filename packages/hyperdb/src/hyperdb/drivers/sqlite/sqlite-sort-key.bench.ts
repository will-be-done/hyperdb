import { bench, describe } from "vitest";
import { encodeSqliteSortKeyTuple } from "./sqlite-sort-key";

const keyCount = 10_000;
// The shape of a typical index key: two strings, a number, then the row id.
const tuples = Array.from({ length: keyCount }, (_, i) => [
  `project-${i % 64}`,
  i % 3 === 0 ? "done" : "todo",
  i,
  `task-${i}`,
]);

let _keySink = 0;

describe(`encodeSqliteSortKeyTuple ${keyCount} index keys`, () => {
  for (const mode of ["scan", "stored"] as const) {
    bench(
      `${mode} mode`,
      () => {
        let bytes = 0;
        for (const tuple of tuples) {
          bytes += encodeSqliteSortKeyTuple(tuple, mode).length;
        }
        _keySink = bytes;
      },
      { time: 1000 },
    );
  }
});

export const readBenchSink = () => _keySink;
