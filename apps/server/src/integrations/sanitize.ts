/**
 * Make an error safe to store/return: message only (no stack), known secrets
 * and anything that looks like credentials removed, length-capped.
 */
export function sanitizeError(err: unknown, secrets: readonly string[], max = 500): string {
  let msg: string;
  if (err instanceof Error) msg = err.message || err.name;
  else if (typeof err === 'string') msg = err;
  else msg = 'Unknown error';

  for (const s of secrets) {
    if (s.length >= 4) msg = msg.split(s).join('[redacted]');
  }
  msg = msg
    // Authorization headers / schemes
    .replace(/(authorization\s*[:=]\s*)(\S+\s+)?\S+/gi, '$1[redacted]')
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    // user:pass@host in URLs
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    // secret-ish query params
    .replace(/([?&](?:access_token|token|api_key|apikey|key|secret|password|client_secret)=)[^&\s]+/gi, '$1[redacted]')
    // GitHub / Atlassian token shapes
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ATATT[A-Za-z0-9_=-]{20,})\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}
