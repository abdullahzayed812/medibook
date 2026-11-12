/** Asserts presence of a value that must exist (e.g. a row just written in this transaction). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`Invariant violated: ${what} not found`);
  return value;
}

/** MySQL DATE → 'YYYY-MM-DD' (mysql2 returns DATE columns as Date at UTC midnight). */
export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  throw new Error('Unexpected DATE value');
}
