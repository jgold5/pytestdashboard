import type { ResultStatus } from '@ptd/shared';

export const FLAKY_THRESHOLD = 0.3;
export const FLAKINESS_WINDOW = 10;

/**
 * Status flips (passed ↔ failed/broken, skipped/unknown ignored) across the
 * last 10 executed results / max(1, n − 1). Input: newest first or oldest first
 * (order only matters for which 10 are taken — pass newest first).
 */
export function computeFlakiness(statusesNewestFirst: readonly ResultStatus[]): number {
  const executed = statusesNewestFirst
    .filter((s) => s === 'passed' || s === 'failed' || s === 'broken')
    .slice(0, FLAKINESS_WINDOW)
    .map((s) => (s === 'passed' ? 'P' : 'F'));
  let flips = 0;
  for (let i = 1; i < executed.length; i++) if (executed[i] !== executed[i - 1]) flips++;
  const value = flips / Math.max(1, executed.length - 1);
  return Math.round(value * 1000) / 1000;
}
