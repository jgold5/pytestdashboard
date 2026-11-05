/**
 * Tiny glob matcher for GITHUB_TEST_PATH_GLOBS (no dependency):
 * `**` (any number of path segments, incl. zero), `*` (within a segment),
 * `?` (one char within a segment). Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atSegStart = i === 0 || g[i - 1] === '/';
        if (atSegStart && g[i + 2] === '/') {
          re += '(?:[^/]*/)*'; // "**/" — zero or more directories
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function createGlobMatcher(globs: readonly string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p) => {
    const path = p.replace(/^\/+/, '');
    return res.some((r) => r.test(path));
  };
}
