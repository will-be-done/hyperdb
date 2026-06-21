const canFreezeObject = (value: object): boolean => {
  // Object.freeze throws for non-empty typed arrays. ArrayBuffer contents are
  // still mutable through views, but freezing the wrapper is harmless.
  return !ArrayBuffer.isView(value);
};

export const deepFreeze = <T>(value: T): T => {
  const seen = new WeakSet<object>();

  const freeze = (current: unknown): void => {
    if (current === null) return;

    const type = typeof current;
    if (type !== "object" && type !== "function") return;

    const object = current as object;
    if (seen.has(object)) return;
    seen.add(object);

    for (const key of Reflect.ownKeys(object)) {
      freeze((object as Record<PropertyKey, unknown>)[key]);
    }

    if (canFreezeObject(object) && !Object.isFrozen(object)) {
      Object.freeze(object);
    }
  };

  freeze(value);
  return value;
};
