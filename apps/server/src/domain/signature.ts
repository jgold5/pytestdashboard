/**
 * Failure signatures + triage suggestions (SPEC "Failure signatures" and
 * "Suggested triage"). Messages are untrusted (allure uploads): input is capped
 * (16 KB → first 8 non-empty lines, each ≤ 2,000 chars) and every regex uses
 * bounded quantifiers / disjoint alternatives so matching stays linear
 * (SECURITY_REVIEW F-04, R2-01).
 */
import { createHash } from 'node:crypto';
import type { TriageCategory } from '@ptd/shared';

export const SIGNATURE_LIMITS = {
  scanChars: 16 * 1024,
  lines: 8,
  lineChars: 2000,
  /** Protected tokens per line (codes, ids…); beyond this they are normalized like any text. */
  tokens: 64,
} as const;

/** First non-empty lines of a message, capped (no regex over the raw input). */
export function messageLines(message: string | null | undefined): string[] {
  const text = (message ?? '').slice(0, SIGNATURE_LIMITS.scanChars);
  const out: string[] = [];
  let start = 0;
  while (start <= text.length && out.length < SIGNATURE_LIMITS.lines) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() !== '') out.push(line.slice(0, SIGNATURE_LIMITS.lineChars));
    start = end + 1;
  }
  return out;
}

// --- stable identifiers ----------------------------------------------------------
// Oracle (ORA/TNS/PLS 5 digits, SQL*Plus SP2 4 digits).
const ORACLE_CODE = /\b(?:ORA|TNS|PLS)-\d{5}\b|\bSP2-\d{4}\b/i;
const ORACLE_CODE_G = new RegExp(ORACLE_CODE.source, 'gi');
// SQLSTATE[23000] / SQLState: 08006 / sqlstate=42P01 — the 5-char code must contain a digit.
const SQLSTATE_G = /\bSQL ?STATE\b[^A-Za-z0-9\n]{0,3}((?=[0-9A-Z]{0,4}\d)[0-9A-Z]{5})\b\]?/gi;
// HTTP 503 / HTTP/1.1 503 / statusCode: 500 / status code 404 / 500 Server Error
const HTTP_G =
  /\bHTTP(?:\/\d(?:\.\d)?)?[ :]{1,3}([1-5]\d\d)\b|\bstatus[ _]?code\b[^A-Za-z0-9\n]{0,3}([1-5]\d\d)\b|\b([1-5]\d\d) (?:Client|Server) Error\b/gi;
// Fully-qualified Java/Python exception class → simple name (case-sensitive).
const FQCN_G = /\b(?:[a-z_][\w$]{0,60}\.){1,12}([A-Z][\w$]{0,100}?(?:Exception|Error|Fault|Failure|Warning))\b/g;
// Camel exchange / message ids: ID-host-1234-1700000000-0-5, ActiveMQ ID:host-1-2-1:1:1:1
const EXCHANGE_ID_G = /\bID-[\w.-]{1,200}/g;
const MESSAGE_ID_G = /\bID:[\w.:-]{1,200}/g;
// 2026-11-04T12:34:56.789Z / 2026-11-04 12:34:56,789 / 2026-11-04
const TIMESTAMP_G =
  /\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:[.,]\d{1,9})?)?(?:Z|[+-]\d\d:?\d\d)?)?(?![\w:])/g;
const CAUSED_BY = /^\s{0,40}Caused by:\s{0,40}/;

const PUA_ANY = /[\uE000-\uF8FF]/g;
const TOKEN_CHAR = /[\uE000-\uE03F]/g;

/**
 * The "most specific" line drives the signature: Oracle code → SQLSTATE →
 * HTTP status → last "Caused by:" → first line.
 */
export function anchorLine(lines: readonly string[]): { line: string; oracle: boolean } {
  const first = (re: RegExp) => lines.find((l) => {
    re.lastIndex = 0;
    return re.test(l);
  });
  const ora = first(ORACLE_CODE);
  if (ora !== undefined) return { line: ora, oracle: true };
  const st = first(SQLSTATE_G) ?? first(HTTP_G);
  if (st !== undefined) return { line: st, oracle: false };
  let caused: string | undefined;
  for (const l of lines) if (CAUSED_BY.test(l)) caused = l;
  return { line: caused ?? lines[0] ?? '', oracle: false };
}

/**
 * Normalize a failure message so similar failures (differing only in ids,
 * numbers, paths, quoted values, exchange ids, timestamps…) group together,
 * while stable error identifiers (ORA-/TNS-/PLS-/SP2- codes, SQLSTATEs, HTTP
 * statuses, exception class names) are preserved.
 */
export function normalizeFailureMessage(message: string | null | undefined): string {
  const { line: anchor, oracle } = anchorLine(messageLines(message));
  let line = anchor.replace(PUA_ANY, '').replace(CAUSED_BY, '');
  if (oracle) {
    // Oracle-coded line: the code and its text identify the error; the driver /
    // wrapper prefix (cx_Oracle, oracledb, JDBC, Camel) must not split groups.
    ORACLE_CODE_G.lastIndex = 0;
    const m = ORACLE_CODE_G.exec(line);
    // …unless the code sits inside a quoted value (e.g. an assertion about it)
    if (m && !/['"`]/.test(line.slice(0, m.index))) line = line.slice(m.index);
  }

  const tokens: string[] = [];
  const protect = (canon: string) => {
    if (tokens.length >= SIGNATURE_LIMITS.tokens) return canon;
    tokens.push(canon);
    return String.fromCharCode(0xe000 + tokens.length - 1);
  };

  line = line
    .replace(FQCN_G, (_m, simple: string) => simple)
    .replace(EXCHANGE_ID_G, () => protect('<exchange-id>'))
    .replace(MESSAGE_ID_G, () => protect('<msg-id>'))
    .replace(TIMESTAMP_G, () => protect('<ts>'))
    .replace(ORACLE_CODE_G, (m) => protect(m.toLowerCase()))
    .replace(SQLSTATE_G, (_m, code: string) => protect(`sqlstate ${code.toLowerCase()}`))
    .replace(HTTP_G, (_m, a?: string, b?: string, c?: string) => protect(`http ${a ?? b ?? c}`));

  const keepTokens = (m: string) => {
    const inner = m.match(TOKEN_CHAR);
    return inner ? `<str ${inner.join(' ')}>` : '<str>';
  };

  const normalized = line
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<addr>')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, keepTokens)
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g, '<path>')
    .replace(/\b[0-9a-f]{6,}\b/g, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.replace(TOKEN_CHAR, (ch) => tokens[ch.charCodeAt(0) - 0xe000] ?? '');
}

/** sha1 (first 12 hex) of the normalized message. */
export function failureSignature(message: string | null | undefined): string {
  return createHash('sha1').update(normalizeFailureMessage(message)).digest('hex').slice(0, 12);
}

// --- triage suggestion ------------------------------------------------------------

/** Oracle errors that mean "the database / network is not there", not a product bug. */
export const ENVIRONMENT_ORA_CODES: ReadonlySet<string> = new Set([
  '12541', // TNS:no listener
  '12514', // listener does not currently know of service
  '12170', // TNS:connect timeout
  '03113', // end-of-file on communication channel
  '03114', // not connected to ORACLE
  '12537', // TNS:connection closed
  '12535', // TNS:operation timed out
  '12543', // TNS:destination host unreachable
  '12545', // target host or object does not exist
  '01017', // invalid username/password (env credentials)
  '28000', // account is locked
  '00018', // maximum number of sessions exceeded
  '00020', // maximum number of processes exceeded
]);

const ORA_G = /\bORA-(\d{5})\b/gi;
const TNS_CODE = /\bTNS-\d{5}\b/i;
const ENV_TEXT =
  /connection (?:refused|reset)|Connection(?:Refused|Reset)Error|timed out|UnknownHostException|Name or service not known|Temporary failure in name resolution|SQLRecoverableException|Network Adapter could not establish the connection|ActiveMQNotConnectedException|ActiveMQConnectionTimedOutException|java\.net\.ConnectException|Failed to create session factory|No consumers available on endpoint/i;
// JMS / ActiveMQ / Artemis + connect/connection/transport on the same line (bounded gap).
const JMS_CONNECT = /\b(?:jms|activemq|artemis)\w{0,60}\b[^\n]{0,200}?\b(?:connect\w{0,20}|transport)\b/i;

/**
 * Heuristic triage hint from a failure message: `environment` for
 * connectivity / infrastructure failures, otherwise null. Never applied
 * automatically — the UI offers it as a one-click bulk note.
 */
export function suggestTriage(message: string | null | undefined): TriageCategory | null {
  for (const line of messageLines(message)) {
    ORA_G.lastIndex = 0;
    for (const m of line.matchAll(ORA_G)) if (ENVIRONMENT_ORA_CODES.has(m[1] ?? '')) return 'environment';
    if (TNS_CODE.test(line) || ENV_TEXT.test(line) || JMS_CONNECT.test(line)) return 'environment';
  }
  return null;
}
