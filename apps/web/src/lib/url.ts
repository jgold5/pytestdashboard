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
