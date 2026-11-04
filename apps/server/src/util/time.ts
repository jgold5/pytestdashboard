export const nowIso = (): string => new Date().toISOString();

/** YYYY-MM-DD (UTC) */
export const isoDate = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function msToIso(ms: number | undefined | null): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
