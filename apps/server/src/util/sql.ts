/** Escape LIKE wildcards; use with `ESCAPE '\\'`. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const containsPattern = (input: string): string => `%${escapeLike(input)}%`;
