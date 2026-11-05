/**
 * Returns the URL if (and only if) it is an absolute http(s) URL, else null.
 * Used before rendering any user/integration supplied URL as a link so that
 * `javascript:`, `data:`, `vbscript:` etc. can never reach an href.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Build a query string from a plain object, skipping undefined/null/'' values. */
export function toQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Validate a post-login `next=` target (SECURITY_REVIEW R2-05). Only same-site
 * paths are allowed: a single leading "/" followed by a char that is not "/" or
 * "\" (or just "/"), no backslashes, whitespace or control characters anywhere
 * (the URL parser strips \t \n \r, turning "/\t/evil" into "//evil"). Anything
 * else falls back to "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || raw[0] !== '/') return '/';
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(raw)) return '/';
  try {
    const base = 'http://same-origin.invalid';
    const u = new URL(raw, base);
    // dot-segments can normalise "/.//evil" into "//evil" (protocol-relative)
    if (u.origin !== base || u.pathname.startsWith('//')) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}
