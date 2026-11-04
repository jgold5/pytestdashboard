/** Neutralize spreadsheet formula injection: prefix ' to cells starting with = + - @ \t \r. */
export function csvSafeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
