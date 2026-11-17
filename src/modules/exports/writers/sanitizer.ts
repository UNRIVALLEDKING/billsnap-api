const FORMULA_PREFIXES = ["=", "+", "-", "@"];

/**
 * Formula injection protection (SEC-10).
 * Prepends `'` if any string begins with `=`, `+`, `-`, or `@`.
 */
export function sanitizeFormula(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  const trimmed = value.trimStart();
  if (FORMULA_PREFIXES.some((char) => trimmed.startsWith(char))) {
    return `'${value}`;
  }
  return value;
}

/**
 * Sanitizes any cell value for spreadsheet export.
 * Numbers, booleans, and nulls are left untouched.
 * Strings starting with formula triggers are prepended with `'`.
 */
export function sanitizeCellValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeFormula(value) as unknown as T;
  }
  return value;
}
