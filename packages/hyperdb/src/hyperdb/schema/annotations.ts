/** A value attached to a column or table with `.with()`. HyperDB stores it but never reads it; plugins do. */
export type Annotation<TValue = unknown> = {
  readonly key: string;
  readonly value: TValue;
};

type AnnotatedTable = {
  readonly annotations: readonly Annotation[];
  readonly fieldAnnotations: Readonly<Record<string, readonly Annotation[]>>;
};

export type AnnotationDefinition<TArgs extends unknown[], TValue> = ((
  ...args: TArgs
) => Annotation<TValue>) & {
  readonly key: string;
  /** The table-level value, or undefined. */
  of(table: AnnotatedTable): TValue | undefined;
  /** Names of the columns carrying this annotation. */
  fields(table: AnnotatedTable): string[];
  /** Columns carrying this annotation, with their values. */
  columns(table: AnnotatedTable): { field: string; value: TValue }[];
};

function find<TValue>(
  annotations: readonly Annotation[],
  key: string,
): TValue | undefined {
  return annotations.findLast((annotation) => annotation.key === key)?.value as
    | TValue
    | undefined;
}

/**
 * Define an annotation. Keys identify annotations, so prefix them with the
 * owning package, such as "hyperdb.undo.ignore".
 */
export function defineAnnotation(key: string): AnnotationDefinition<[], true>;
export function defineAnnotation<TArgs extends unknown[], TValue>(
  key: string,
  create: (...args: TArgs) => TValue,
): AnnotationDefinition<TArgs, TValue>;
export function defineAnnotation(
  key: string,
  create: (...args: unknown[]) => unknown = () => true,
): AnnotationDefinition<unknown[], unknown> {
  const columns = (table: AnnotatedTable) =>
    Object.entries(table.fieldAnnotations).flatMap(([field, annotations]) =>
      annotations.some((annotation) => annotation.key === key)
        ? [{ field, value: find(annotations, key) }]
        : [],
    );
  return Object.assign(
    (...args: unknown[]): Annotation => ({ key, value: create(...args) }),
    {
      key,
      of: (table: AnnotatedTable) => find(table.annotations, key),
      fields: (table: AnnotatedTable) =>
        columns(table).map((column) => column.field),
      columns,
    },
  );
}
