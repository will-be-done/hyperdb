// Every command carries this brand, so the runner never mistakes a user
// object with a matching `type` for a command. Symbol.for keeps commands
// created by another copy of HyperDB in the same bundle recognizable.
export const commandBrand: unique symbol = Symbol.for("hyperdb.command");

export type CommandBrand = { readonly [commandBrand]: true };

export const isCommandOfType = <TType extends string>(
  value: unknown,
  type: TType,
): value is CommandBrand & { type: TType } =>
  typeof value === "object" &&
  value !== null &&
  (value as Partial<CommandBrand>)[commandBrand] === true &&
  (value as { type?: unknown }).type === type;
