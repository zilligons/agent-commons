import { AdapterFailure } from "./types";

/** Server-local capability. JSON/configuration cannot create an admission. */
export type AccountingPermit = Readonly<object>;
type Binding = { validate(): void; start(): void };
const permits = new WeakMap<object, Binding>();

export function issueAccountingPermit(binding: Binding): AccountingPermit {
  const permit = Object.freeze({});
  permits.set(permit, binding);
  return permit;
}

function bindingFor(value?: unknown): Binding {
  const binding = value !== null && typeof value === "object" ? permits.get(value) : undefined;
  if (!binding) throw new AdapterFailure("LIMIT_UNSUPPORTED", "A metered live reservation is required", null, false);
  return binding;
}

export function assertAccountingPermit(permit?: unknown): void {
  bindingFor(permit).validate();
}

export function markAccountingDispatchStarted(permit?: unknown): void {
  const binding = bindingFor(permit);
  binding.validate();
  binding.start();
}

export function invalidateAccountingPermit(permit: AccountingPermit): void {
  permits.delete(permit);
}
