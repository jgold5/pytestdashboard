import { createHash } from 'node:crypto';

/**
 * Normalize the first line of a failure message so that similar failures
 * (differing only in ids, numbers, paths, quoted values…) group together.
 */
export function normalizeFailureMessage(message: string | null | undefined): string {
  const firstLine = (message ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return firstLine
    .slice(0, 2000)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<addr>')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '<str>')
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g, '<path>')
    .replace(/\b[0-9a-f]{6,}\b/g, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sha1 (first 12 hex) of the normalized message. */
export function failureSignature(message: string | null | undefined): string {
  return createHash('sha1').update(normalizeFailureMessage(message)).digest('hex').slice(0, 12);
}
