const dbIds = new WeakMap<object, string>();
const dbLabels = new Map<string, string>();

let idCounter = 0;
let dbCounter = 0;

type TraceDBIdentified = {
  getId?: () => string;
  getDBName?: () => string | undefined;
};

export type TraceDBInfo = {
  id: string;
  label: string;
};

export const nextTraceId = (prefix: string): string => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

export const getTraceDBInfo = (db: object): TraceDBInfo => {
  const explicitId = (db as TraceDBIdentified).getId?.();
  const explicitName = (db as TraceDBIdentified).getDBName?.();

  if (explicitId) {
    if (explicitName) {
      dbLabels.set(explicitId, explicitName);
    }

    if (!dbLabels.has(explicitId)) {
      dbCounter += 1;
      dbLabels.set(explicitId, `DB ${dbCounter}`);
    }

    return {
      id: explicitId,
      label: dbLabels.get(explicitId) ?? explicitId,
    };
  }

  let id = dbIds.get(db);

  if (!id) {
    dbCounter += 1;
    id = `db-${dbCounter}`;
    dbIds.set(db, id);
    dbLabels.set(id, `DB ${dbCounter}`);
  }

  return {
    id,
    label: dbLabels.get(id) ?? id,
  };
};
