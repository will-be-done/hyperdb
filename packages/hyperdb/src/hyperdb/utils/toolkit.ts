// Weight used to push `null`/`undefined` after other values when sorting, with `null` before `undefined`.
function nullishRank(value: unknown): number {
  if (value === null) {
    return 1;
  }
  if (value === undefined) {
    return 2;
  }
  return 0;
}

function compareAscending(a: unknown, b: unknown): 0 | -1 | 1 {
  const aRank = nullishRank(a);
  const bRank = nullishRank(b);

  // Compare by rank first: regular value (0) < null (1) < undefined (2).
  if (aRank < bRank) {
    return -1;
  }
  if (aRank > bRank) {
    return 1;
  }
  if (aRank !== 0) {
    return 0; // Both are the same kind of nullish.
  }

  // Both are regular values.
  const comparableA = a as string | number | bigint;
  const comparableB = b as string | number | bigint;

  if (comparableA < comparableB) {
    return -1;
  }
  if (comparableA > comparableB) {
    return 1;
  }
  return 0;
}

export function compareValues(
  a: unknown,
  b: unknown,
  order: "asc" | "desc",
): 0 | -1 | 1 {
  // Descending order is the ascending comparison with the operands swapped.
  return order === "asc" ? compareAscending(a, b) : compareAscending(b, a);
}

/**
 * Sorts an array of objects based on the given `criteria` and their corresponding order directions.
 *
 * - If you provide keys, it sorts the objects by the values of those keys.
 * - If you provide functions, it sorts based on the values returned by those functions.
 *
 * The function returns the array of objects sorted in corresponding order directions.
 * If two objects have the same value for the current criterion, it uses the next criterion to determine their order.
 * If the number of orders is less than the number of criteria, it uses the last order for the rest of the criteria.
 *
 * @template T - The type of elements in the array.
 * @param arr - The array of objects to be sorted.
 * @param criteria  - The criteria for sorting. This can be an array of object keys or functions that return values used for sorting.
 * @param orders - An array of order directions ('asc' for ascending or 'desc' for descending).
 * @returns The sorted array.
 *
 * @example
 * // Sort an array of objects by 'user' in ascending order and 'age' in descending order.
 * const users = [
 *   { user: 'fred', age: 48 },
 *   { user: 'barney', age: 34 },
 *   { user: 'fred', age: 40 },
 *   { user: 'barney', age: 36 },
 * ];
 *
 * const result = orderBy(users, [obj => obj.user, 'age'], ['asc', 'desc']);
 * // result will be:
 * // [
 * //   { user: 'barney', age: 36 },
 * //   { user: 'barney', age: 34 },
 * //   { user: 'fred', age: 48 },
 * //   { user: 'fred', age: 40 },
 * // ]
 */
export function orderBy<T extends object>(
  arr: readonly T[],
  criteria: Array<((item: T) => unknown) | keyof T>,
  orders: Array<"asc" | "desc">,
): T[] {
  return arr.slice().sort((a, b) => {
    const ordersLength = orders.length;

    for (let i = 0; i < criteria.length; i++) {
      const order = ordersLength > i ? orders[i] : orders[ordersLength - 1];
      const criterion = criteria[i];
      const criterionIsFunction = typeof criterion === "function";

      const valueA = criterionIsFunction ? criterion(a) : a[criterion];
      const valueB = criterionIsFunction ? criterion(b) : b[criterion];

      const result = compareValues(valueA, valueB, order);

      if (result !== 0) {
        return result;
      }
    }

    return 0;
  });
}

/**
 * Sorts an array of objects based on the given `criteria`.
 *
 * - If you provide keys, it sorts the objects by the values of those keys.
 * - If you provide functions, it sorts based on the values returned by those functions.
 *
 * The function returns the array of objects sorted in ascending order.
 * If two objects have the same value for the current criterion, it uses the next criterion to determine their order.
 *
 * @template T - The type of the objects in the array.
 * @param arr - The array of objects to be sorted.
 * @param criteria - The criteria for sorting. This can be an array of object keys or functions that return values used for sorting.
 * @returns The sorted array.
 *
 * @example
 * const users = [
 *  { user: 'foo', age: 24 },
 *  { user: 'bar', age: 7 },
 *  { user: 'foo', age: 8 },
 *  { user: 'bar', age: 29 },
 * ];
 *
 * sortBy(users, ['user', 'age']);
 * sortBy(users, [obj => obj.user, 'age']);
 * // results will be:
 * // [
 * //   { user : 'bar', age: 7 },
 * //   { user : 'bar', age: 29 },
 * //   { user : 'foo', age: 8 },
 * //   { user : 'foo', age: 24 },
 * // ]
 */
export function sortBy<T extends object>(
  arr: readonly T[],
  criteria: Array<((item: T) => unknown) | keyof T>,
): T[] {
  return orderBy(arr, criteria, ["asc"]);
}

export function omitBy<T extends Record<PropertyKey, unknown>>(
  obj: T,
  predicate: (value: T[keyof T], key: keyof T) => boolean,
): Partial<T> {
  const result: Partial<T> = {};

  for (const key of Reflect.ownKeys(obj) as Array<keyof T>) {
    if (!predicate(obj[key], key)) {
      result[key] = obj[key];
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function cloneDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item)) as T;
  }

  if (value instanceof Date) {
    return new Date(value) as T;
  }

  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }

  if (value instanceof DataView) {
    return new DataView(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    ) as T;
  }

  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );

    return new (value.constructor as { new (buffer: ArrayBufferLike): T })(
      buffer,
    );
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<PropertyKey, unknown> = {};

  for (const key of Reflect.ownKeys(value)) {
    result[key] = cloneDeep(value[key]);
  }

  return result as T;
}
