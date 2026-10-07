export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a nonempty string"}.`);
  }
  return value;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function positive(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return value;
}
