export type HyperDBErrorCode =
  | "ASYNC_IN_SYNC_EXECUTION"
  | "DB_CLOSED"
  | "DUPLICATE_ID"
  | "HYBRID_DB_CRASHED"
  | "INDEX_NOT_FOUND"
  | "PERSISTENCE_QUEUE_FULL"
  | "READONLY_TRANSACTION"
  | "TABLE_NOT_FOUND"
  | "TRANSACTION_FINISHED"
  | "UNDO_CONFLICT"
  | "UNSUPPORTED_COMMAND"
  | "VALIDATION"
  | "WRITES_DISALLOWED";

// Symbol.for keeps detection working when a bundle contains more than one
// copy of HyperDB, where `instanceof` would fail.
const hyperDBErrorBrand = Symbol.for("hyperdb.error");

/** Base class for errors raised by HyperDB. Match on `code`, not `message`. */
export class HyperDBError extends Error {
  readonly code: HyperDBErrorCode;

  constructor(code: HyperDBErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HyperDBError";
    this.code = code;
    Object.defineProperty(this, hyperDBErrorBrand, { value: true });
  }
}

/** Thrown when an insert would create a second row with an existing id. */
export class DuplicateIdError extends HyperDBError {
  readonly id: string;

  constructor(id: string) {
    super("DUPLICATE_ID", `Record with duplicate id already exists: ${id}`);
    this.name = "DuplicateIdError";
    this.id = id;
  }
}

/** Thrown when action/selector args or stored rows fail schema validation. */
export class ValidationError extends HyperDBError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "ValidationError";
  }
}

export function isHyperDBError(error: unknown): error is HyperDBError;
export function isHyperDBError<TCode extends HyperDBErrorCode>(
  error: unknown,
  code: TCode,
): error is HyperDBError & { code: TCode };
export function isHyperDBError(
  error: unknown,
  code?: HyperDBErrorCode,
): error is HyperDBError {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { [hyperDBErrorBrand]?: unknown })[hyperDBErrorBrand] !== true
  ) {
    return false;
  }
  return code === undefined || (error as { code?: unknown }).code === code;
}
