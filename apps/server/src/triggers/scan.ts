/**
 * Scans a repository snapshot for Camel route triggers and the pytest tests that
 * cover them. Pure functions, no I/O: the upload code hands in file contents.
 *
 * - Routes come from Camel XML (`<route id="…"><from uri="…"/>`, any namespace
 *   prefix, `<from ref>` → `<endpoint id uri>`). Routes started by a file
 *   (file/ftp/ftps/sftp/smb), a schedule (quartz/cron/timer/scheduler), another route
 *   (direct), a queue (seda/jms…), Kafka or HTTP (netty-http/rest…) are triggers, and so are
 *   routes whose whole `from` URI is a property no properties file fills in.
 * - `{{key}}` / `${key}` placeholders (with `:default`) are filled in from every
 *   `.properties` file; a key with different values in different files (one file
 *   per environment) is reported with each value instead of guessing.
 * - A test covers a trigger when a string in its decorators (Allure labels, pytest
 *   markers) or an `allure.dynamic.*` call in its body names the route id, the
 *   schedule's name, or a file the trigger would pick up.
 */
import type { Trigger, TriggerCoverage, TriggerKind } from '@ptd/shared';

export type PropertyIndex = Map<string, Array<{ file: string; value: string }>>;

const MAX_PROPERTY_FILE_KEYS = 10_000;
const MAX_VALUE = 2_000;

// ---------------------------------------------------------------------------
// .properties
// ---------------------------------------------------------------------------

function unescapeProperty(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'f' ? '\f' : c;
  });
}

/** Java .properties: `#`/`!` comments, `=`, `:` or whitespace separators, `\` line continuations, escapes. */
export function parsePropertiesFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n|\r/);
  for (let i = 0; i < lines.length && out.length < MAX_PROPERTY_FILE_KEYS; i++) {
    let line = (lines[i] ?? '').replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // continuation: an odd number of trailing backslashes joins the next line
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + (lines[++i] ?? '').replace(/^\s+/, '');
    }
    let k = 0;
    while (k < line.length) {
      const c = line[k] as string;
      if (c === '\\') k += 2;
      else if (c === '=' || c === ':' || /\s/.test(c)) break;
      else k++;
    }
    const key = unescapeProperty(line.slice(0, k));
    let rest = line.slice(k).replace(/^\s*/, '');
    if (rest.startsWith('=') || rest.startsWith(':')) rest = rest.slice(1).replace(/^\s*/, '');
    if (key) out.push([key, unescapeProperty(rest).slice(0, MAX_VALUE)]);
  }
  return out;
}

export function buildPropertyIndex(files: ReadonlyArray<{ path: string; text: string }>): PropertyIndex {
  const index: PropertyIndex = new Map();
  for (const f of files) {
    for (const [key, value] of parsePropertiesFile(f.text)) {
      const list = index.get(key) ?? [];
      const same = list.find((v) => v.file === f.path);
      if (same) same.value = value; // later line in the same file wins, as in Java
      else list.push({ file: f.path, value });
      index.set(key, list);
    }
  }
  return index;
}

/** Camel simple/file language functions that also use `${…}`. */
const CAMEL_LANGUAGE =
  /^(?:(?:date|file|bean|ref|properties|type|random|env|sysenv|sys|bodyAs|mandatoryBodyAs|headerAs|exchangePropertyAs|header|headers|exchangeProperty|variable)\s*[:(]|(?:header|headers|exchangeProperty|body|sys|sysenv|env|exception|variable|variables)\s*(?:[.[(]|$)|(?:in|out)\.(?:header|headers|body)\b|(?:exchangeId|id|messageTimestamp|camelId|routeId|uuid|body|in\.body|exception|exchange|threadName|hostName|stepId)\s*$)/;

const PLACEHOLDER = /\{\{([^{}]+)\}\}|\$\{([^{}]+)\}/g;

export interface Resolved {
  /** Single-valued placeholders filled in; the others left as written. */
  text: string;
  /** Every placeholder that could have several values filled with its first value — for classifying the endpoint. */
  firstVariant: string;
  unresolved: Trigger['unresolved'];
}

/**
 * The definitions of a key that apply to a file: those in the properties files
 * nearest to it (longest shared folder path). A repo with one properties file per
 * module (`<module>/config/application-<module>.properties`) resolves each module's
 * routes from its own file, falling back to shared ones higher up.
 */
function nearest(values: Array<{ file: string; value: string }> | undefined, near: string | undefined) {
  if (!values || !near || values.length < 2) return values;
  const dir = near.split('/').slice(0, -1);
  // a properties file applies to a route when it sits in a folder above it, or in the route's own module
  // (resources/<module>/config/…); another module's file never does. Environment folders elsewhere (config/prod) all apply.
  const root = moduleRoot(near);
  const applies = values.filter((v) => {
    const d = v.file.split('/').slice(0, -1);
    return (d.length <= dir.length && d.every((s, k) => dir[k] === s)) || (root !== null && v.file.startsWith(`${root}/`));
  });
  const sameTree = (v: { file: string }) => {
    const r = moduleRoot(v.file);
    return r !== null && r !== root;
  };
  if (applies.length > 0) values = applies;
  else if (root !== null) values = values.filter((v) => !sameTree(v)).length ? values.filter((v) => !sameTree(v)) : values;
  if (values.length < 2) return values;
  let best = -1;
  const scored = values.map((v) => {
    const d = v.file.split('/').slice(0, -1);
    let n = 0;
    while (n < d.length && n < dir.length && d[n] === dir[n]) n++;
    best = Math.max(best, n);
    return { v, n };
  });
  return scored.filter((x) => x.n === best).map((x) => x.v);
}

/** `src/main/resources/<module>` for a file in a module, else null. */
function moduleRoot(file: string): string | null {
  const segs = file.split('/');
  const r = segs.lastIndexOf('resources');
  return r >= 0 && r + 2 < segs.length ? segs.slice(0, r + 2).join('/') : null;
}

/** Camel property functions: `{{env:NAME}}`, `{{sys:NAME:default}}`, `{{service:NAME}}` — not keys of a properties file. */
const PROPERTY_FUNCTION = /^(env|sys|sysenv|service|service\.host|service\.port)$/i;

/** Fill in placeholders (values may reference other keys; ≤ 5 rounds). `near` = the file being resolved, for module-scoped properties. */
export function resolvePlaceholders(input: string, props: PropertyIndex, near?: string): Resolved {
  const unresolved = new Map<string, Trigger['unresolved'][number]>();
  const fill = (text: string, pickFirst: boolean): string => {
    let out = text;
    for (let round = 0; round < 5; round++) {
      let changed = false;
      out = out.replace(PLACEHOLDER, (whole, a: string | undefined, b: string | undefined) => {
        const body = (a ?? b ?? '').trim();
        const colon = body.indexOf(':');
        // `{{env:NAME[:default]}}`: an environment variable, unknown here; its default when it has one
        if (a !== undefined && colon > 0 && PROPERTY_FUNCTION.test(body.slice(0, colon))) {
          const rest = body.slice(colon + 1);
          const c2 = rest.indexOf(':');
          if (c2 >= 0) {
            changed = true;
            return rest.slice(c2 + 1);
          }
          if (!unresolved.has(body)) unresolved.set(body, { key: body, values: [] });
          return whole;
        }
        // `${date:now:yyyyMMdd}` (Camel file language) is not a property key
        const key = colon >= 0 ? body.slice(0, colon) : body;
        const fallback = colon >= 0 ? body.slice(colon + 1) : null;
        const values = nearest(props.get(key), near);
        const distinct = [...new Set((values ?? []).map((v) => v.value))];
        if (distinct.length === 1) {
          changed = true;
          return distinct[0] as string;
        }
        if (distinct.length === 0) {
          // ${…} can also be Camel's file/simple language (e.g. ${date:now:yyyyMMdd}): not a property
          const camel = a === undefined && CAMEL_LANGUAGE.test(body);
          // {{key:default}} (Camel) and ${key:default} (Spring): the default when no file sets the key
          if (fallback !== null && !camel) {
            changed = true;
            return fallback;
          }
          if (!camel && !unresolved.has(key)) unresolved.set(key, { key, values: [] });
          return whole;
        }
        if (!unresolved.has(key)) unresolved.set(key, { key, values: values ?? [] });
        if (pickFirst) {
          changed = true;
          return values?.[0]?.value ?? whole;
        }
        return whole;
      });
      if (!changed) break;
    }
    return out;
  };
  const text = fill(input, false);
  return { text, firstVariant: fill(input, true), unresolved: [...unresolved.values()] };
}

// ---------------------------------------------------------------------------
// Camel endpoint URIs
// ---------------------------------------------------------------------------

const FILE_SCHEMES = new Set(['file', 'ftp', 'ftps', 'sftp', 'smb']);
const SCHEDULE_SCHEMES = new Set(['quartz', 'quartz2', 'cron', 'timer', 'scheduler']);
const DIRECT_SCHEMES = new Set(['direct', 'direct-vm']);
const QUEUE_SCHEMES = new Set(['seda', 'vm', 'jms', 'activemq', 'amqp', 'sjms', 'sjms2', 'ibmmq', 'sqs', 'aws-sqs', 'aws2-sqs', 'rabbitmq', 'spring-rabbitmq', 'paho', 'paho-mqtt5', 'nats']);
const REST_SCHEMES = new Set(['rest', 'rest-api', 'restlet', 'netty-http', 'netty4-http', 'jetty', 'servlet', 'platform-http', 'undertow', 'http', 'https', 'cxfrs', 'spark-rest', 'vertx-http', 'coap']);

/** What kind of trigger a `from` endpoint is, or null for one that isn't (bean:, imaps:…). */
export function kindOfScheme(scheme: string): TriggerKind | null {
  if (FILE_SCHEMES.has(scheme)) return 'file';
  if (SCHEDULE_SCHEMES.has(scheme)) return 'schedule';
  if (DIRECT_SCHEMES.has(scheme)) return 'direct';
  // custom JMS components are named after their connection: jmsComponentOrders:queue:X
  if (QUEUE_SCHEMES.has(scheme) || scheme.startsWith('jms')) return 'queue';
  if (scheme === 'kafka') return 'kafka';
  if (REST_SCHEMES.has(scheme)) return 'rest';
  return null;
}

/** A `from` URI that is nothing but a placeholder (`{{invoice.sftp.url}}`, `${in.uri}`), maybe with options after it. */
const PROPERTY_ONLY = /^\s*(?:\{\{([^{}]+)\}\}|\$\{([^{}]+)\})/;
/** The scheme a placeholder's key suggests (`{{sftp.invoice.url}}`, `{{invoiceSftpUri}}` → sftp), for a file poll the properties don't fill in. */
export function guessFileScheme(key: string): string | null {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return ['sftp', 'ftps', 'ftp', 'smb'].find((w) => words.includes(w)) ?? null;
}

/** `master:lockName:file:/in` (only one node consumes): the endpoint inside. */
export const unwrapMaster = (uri: string): string => /^\s*master:[^:]*:(.+)$/s.exec(uri)?.[1] ?? uri;

function decode(v: string): string {
  const raw = /^RAW\((.*)\)$/s.exec(v) ?? /^RAW\{(.*)\}$/s.exec(v);
  if (raw) return raw[1] as string;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v.replace(/\+/g, ' ');
  }
}

export interface Endpoint {
  scheme: string;
  path: string;
  params: Record<string, string>;
}

export function parseEndpoint(uri: string): Endpoint | null {
  const m = /^\s*([A-Za-z][\w+.-]*):(.*)$/s.exec(uri);
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase();
  const rest = (m[2] as string).replace(/^\/\//, '');
  const q = rest.indexOf('?');
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const params: Record<string, string> = {};
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = eq >= 0 ? part.slice(0, eq) : part;
      if (k && !(k in params)) params[k] = eq >= 0 ? decode(part.slice(eq + 1)) : '';
    }
  }
  return { scheme, path, params };
}

// ---------------------------------------------------------------------------
// Camel XML
// ---------------------------------------------------------------------------

export interface RawInput {
  uri: string | null;
  ref: string | null;
  line: number;
}

/** A `<when>` / `<filter>` branch in a route: its simple expression and where it sends the message. */
export interface RawCondition {
  kind: 'when' | 'filter';
  expr: string;
  target: string | null;
  line: number;
  /** Endpoints sent to inside this branch only. */
  calls?: string[];
}

export interface RawRoute {
  routeId: string | null;
  file: string;
  line: number;
  /** `<from>`s in order (usually one). */
  inputs: RawInput[];
  conditions: RawCondition[];
  /** Endpoints the route sends to outside any <when>/<filter>/<otherwise> (<to>, <toD>, <wireTap>, <enrich>…), as written. */
  calls?: string[];
  /**
   * Marker files the route itself handles (load routes delete one when they finish:
   * `${file:parent}/LOADTRIGGER`, or a deleteFileName / doneFile header): the route's trigger
   * file when its `<from>` has no doneFileName.
   */
  markers: string[];
  /** Inside a <routeTemplate>: a blueprint, not a route until instantiated. */
  template?: boolean;
}

/** `${file:parent}/NAME`: a file next to the one being processed. */
const PARENT_FILE = /\$(?:simple)?\{\s*file:parent\s*\}\s*[/\\]\s*([^\s"'<>;,()]+)/g;
/** <setHeader name="deleteFileName"><constant|simple>…</…>, also Camel 2's headerName / propertyName. */
const MARKER_HEADER =
  /<\s*(?:[\w.-]+:)?set(?:Header|Property)\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*<\s*(?:[\w.-]+:)?(constant|simple)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:[\w.-]+:)?\2\s*>/g;
const MARKER_NAME = /(done|delete|trigger|marker|flag)/i;

/** Marker file names in a route's XML (comments removed). */
export function routeMarkers(body: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const v = decodeXml(raw).replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
    const name = v.split(/[/\\]/).pop() ?? '';
    // a bare file name, possibly with placeholders / file language (${file:onlyname}.done)
    if (name && name.length <= 200 && /^[\w.{}$:-]+$/.test(name) && !/^\$\{[^}]*\}$/.test(name)) out.push(name);
  };
  for (const m of body.matchAll(PARENT_FILE)) add(m[1] as string);
  for (const m of body.matchAll(MARKER_HEADER)) {
    const a = attrs(m[1] ?? '');
    const header = a.name ?? a.headerName ?? a.propertyName ?? '';
    if (/file/i.test(header) && MARKER_NAME.test(header)) add(m[3] as string);
  }
  return [...new Set(out)];
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? '';
  });
}

/** Blank out comments, CDATA and processing instructions, keeping offsets (and so line numbers) intact. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

const TAG = /<\s*(\/)?\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?\s*>/g;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) {
    const name = (m[1] as string).replace(/^[\w.-]+:/, ''); // drop namespace prefix
    out[name] = decodeXml(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Routes (`<route>` with its `<from>`s and `<when>`/`<filter>` branches) and named endpoints (`<endpoint id uri>`) in one XML file. */
export function scanCamelXml(file: string, xml: string): { routes: RawRoute[]; endpoints: Map<string, string> } {
  const text = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/g, blank);
  // CDATA is blanked for tag scanning but its text still matters inside <simple>
  const original = xml;
  const routes: RawRoute[] = [];
  const endpoints = new Map<string, string>();
  const stack: RawRoute[] = [];
  const starts: number[] = [];
  /** Open <when>/<filter>/<otherwise>: what a call inside one belongs to. */
  const branches: Array<Omit<RawCondition, 'kind'> & { kind: RawCondition['kind'] | 'otherwise' }> = [];
  let lineAt = 0;
  let line = 1;
  let template = 0;
  const lineOf = (offset: number): number => {
    for (; lineAt < offset; lineAt++) if (text.charCodeAt(lineAt) === 10) line++;
    return line;
  };
  /** A call inside a branch only happens when the branch does: it belongs to that branch, else to the whole route. */
  const addCall = (route: RawRoute, uri: string) => {
    const list = branches.length ? (branches[branches.length - 1]!.calls ??= []) : (route.calls ??= []);
    if (list.length < 200) list.push(uri);
  };
  for (const m of text.matchAll(TAG)) {
    const closing = m[1] === '/';
    const name = m[2] as string;
    const selfClosing = m[4] === '/';
    const route = stack[stack.length - 1];
    // a <routeTemplate> is a blueprint, not a route: its <route> runs only when instantiated (with parameters)
    if (name === 'routeTemplate') {
      if (closing) template = Math.max(0, template - 1);
      else if (!selfClosing) template++;
      continue;
    }
    if (name === 'route') {
      if (closing) {
        const done = stack.pop();
        const start = starts.pop();
        if (done && start !== undefined) done.markers = routeMarkers(original.slice(start, m.index ?? start).replace(/<!--[\s\S]*?-->/g, ''));
      } else if (!selfClosing) {
        const a = attrs(m[3] ?? '');
        const r: RawRoute = { routeId: a.id ?? a.routeId ?? null, file, line: lineOf(m.index ?? 0), inputs: [], conditions: [], markers: [], calls: [] };
        if (template > 0) r.template = true;
        routes.push(r);
        stack.push(r);
        starts.push((m.index ?? 0) + m[0].length);
      }
      continue;
    }
    if (name === 'when' || name === 'filter' || name === 'otherwise') {
      if (!route) continue;
      if (closing) {
        const b = branches.pop();
        if (b?.expr && b.kind !== 'otherwise') route.conditions.push(b as RawCondition);
      } else if (!selfClosing) branches.push({ kind: name, expr: '', target: null, line: lineOf(m.index ?? 0), calls: [] });
      continue;
    }
    if (closing) continue;
    if (name === 'endpoint') {
      const a = attrs(m[3] ?? '');
      if (a.id && a.uri) endpoints.set(a.id, a.uri);
      continue;
    }
    if (!route) continue; // a <from> outside a <route> is not a route input
    if (name === 'from') {
      const a = attrs(m[3] ?? '');
      route.inputs.push({ uri: a.uri ?? null, ref: a.ref ?? null, line: lineOf(m.index ?? 0) });
    } else if (name === 'simple' && !selfClosing) {
      const branch = branches[branches.length - 1];
      const start = (m.index ?? 0) + m[0].length;
      const close = /<\s*\/\s*(?:[A-Za-z_][\w.-]*:)?simple\s*>/g;
      close.lastIndex = start;
      const end = close.exec(text);
      if (branch && !branch.expr && end) {
        const body = original.slice(start, end.index).replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '');
        branch.expr = decodeXml(body).trim().slice(0, 1000);
      }
    } else if (name === 'to' || name === 'toD') {
      const branch = branches[branches.length - 1];
      const a = attrs(m[3] ?? '');
      if (branch && !branch.target && a.uri) branch.target = a.uri;
      if (a.uri) addCall(route, a.uri);
    } else if (name === 'wireTap' || name === 'enrich' || name === 'pollEnrich' || name === 'inOnly' || name === 'inOut') {
      const a = attrs(m[3] ?? '');
      const uri = a.uri ?? a.url;
      if (uri) addCall(route, uri);
    }
  }
  return { routes, endpoints };
}

// ---------------------------------------------------------------------------
// pytest files: see pytest.ts
// ---------------------------------------------------------------------------

import { scanPytestFiles } from './pytest.js';
export { allureFullName, isPytestFile, scanPytestFile, scanPytestFiles, type ScannedTest } from './pytest.js';

// ---------------------------------------------------------------------------
// Triggers and coverage
// ---------------------------------------------------------------------------

/** Names compare case-, separator- and camelCase-insensitively: invoiceLoad = invoice_load = Invoice-Load. */
export const norm = (s: string): string =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_.-]+/g, '-');

/**
 * Camel `include` is a Java regex. Only simple patterns are tried (no nested
 * quantifiers, bounded length) so an uploaded pattern can't hang the server.
 */
function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  if (pattern.length > 300 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /\\[1-9]|\(\?[<!=]/.test(pattern)) return null;
  try {
    return new RegExp(`^(?:${pattern})$`, flags);
  } catch {
    return null;
  }
}

/** Camel's antInclude is case-sensitive unless the endpoint sets antFilterCaseSensitive=false. */
function antRegex(glob: string, caseSensitive = true): RegExp {
  const re = glob
    .split(',')
    .map((g) =>
      g
        .trim()
        .replace(/[.+^$()|[\]{}\\]/g, '\\$&')
        .split(/\*\*\/?/)
        .map((seg) => seg.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*'),
    )
    .join('|');
  return new RegExp(`^(?:${re})$`, caseSensitive ? '' : 'i');
}

// ---------------------------------------------------------------------------
// Conditions on the file name (<choice><when><simple>${file:name} starts with 'INV_'</simple>…)
// ---------------------------------------------------------------------------

/** ext/noext: after/before the first dot (Camel's file:ext, file:name.noext); ext1/noext1: the last one (.single). */
type NamePart = 'name' | 'onlyname' | 'noext' | 'noext1' | 'ext' | 'ext1';
interface Atom {
  part: NamePart;
  op: 'starts' | 'ends' | 'contains' | 'regex' | 'eq' | 'in';
  value: string;
  negate: boolean;
  /** Ignoring case: =~, ~~, or a name passed through toUpperCase()/toLowerCase(). Camel's other operators are case-sensitive. */
  ci: boolean;
}
export interface FileCondition {
  /** OR of AND-groups. */
  groups: Atom[][];
  display: string;
}

const FILE_REF =
  /\$\{\s*(?:file:(name|onlyname)(\.noext(?:\.single)?)?|file:(ext(?:\.single)?|name\.ext(?:\.single)?)|(?:in\.)?headers?(?:\.|:|\[\s*['"]?)CamelFileName(Only)?(?:['"]?\s*\])?)\s*\}/i;
/** Simple-language operators, longest first; `~starts with`… are this parser's own, for a name passed through toUpperCase(). */
const OPERATORS = String.raw`!~~|~~|!=~|=~|!=|==|~starts\s+with|~ends\s+with|~regex|~in|!startsWith|!starts\s+with|!endsWith|!ends\s+with|!contains|!regex|!in|not\s+starts\s+with|starts\s+with|startsWith|not\s+ends\s+with|ends\s+with|endsWith|not\s+contains|contains|not\s+regex|regex|not\s+in|in`;
const ATOM = new RegExp(`${FILE_REF.source}\\s*(${OPERATORS})\\s*(?:'([^']*)'|"([^"]*)")`, 'gi');

function atomPart(m: RegExpMatchArray): NamePart {
  if (m[3]) return /single$/i.test(m[3]) ? 'ext1' : 'ext';
  if (m[2]) return /single$/i.test(m[2]) ? 'noext1' : 'noext';
  if (m[1]?.toLowerCase() === 'onlyname' || m[4]) return 'onlyname';
  return 'name';
}

const NAME_BASE = String.raw`(?:in\.)?headers?(?:\.|:|\[\s*['"]?)CamelFileName(?:Only)?(?:['"]?\s*\])?|file:(?:name|onlyname)(?:\.noext)?`;
const METHOD_CHAIN = new RegExp(String.raw`\$\{\s*(${NAME_BASE})((?:\.\w+\((?:[^()'"]|'[^']*'|"[^"]*")*\))+)\s*\}`, 'gi');
const BOOLEAN_METHODS: Record<string, string> = {
  startswith: 'starts with',
  endswith: 'ends with',
  contains: 'contains',
  equals: '==',
  equalsignorecase: '=~',
  matches: 'regex',
};

/**
 * Rewrite Java-style calls on the file name into simple-language operators, so one parser
 * handles both: `${header.CamelFileName.toUpperCase().endsWith(".GZ")}` → `${header.CamelFileName} ends with '.GZ'`,
 * `${file:name.substring(9,16)} == 'X'` → `${file:name} contains 'X'` (a part of the name), and
 * `${properties:key}` → `'{{key}}'` (filled in from the properties files like any placeholder).
 */
export function normalizeCondition(expr: string): string {
  return expr
    .replace(/\$\{\s*properties:([^}:]+)(?::[^}]*)?\}/gi, "'{{$1}}'")
    .replace(METHOD_CHAIN, (_whole, base: string, chain: string) => {
      let sub = false;
      let ci = false;
      for (const m of chain.matchAll(/\.(\w+)\(((?:[^()'"]|'[^']*'|"[^"]*")*)\)/g)) {
        const name = (m[1] as string).toLowerCase();
        if (name === 'substring' || name === 'substr') sub = true;
        if (name === 'touppercase' || name === 'tolowercase') ci = true;
        const op = BOOLEAN_METHODS[name];
        if (op) {
          const arg = /^\s*(?:'([^']*)'|"([^"]*)")\s*$/.exec(m[2] ?? '');
          if (!arg) return `\${${base}}`;
          const plain = sub && op !== 'regex' ? 'contains' : op;
          // after toUpperCase()/toLowerCase() the comparison ignores case
          const used = ci ? ({ contains: '~~', '==': '=~', 'starts with': '~starts with', 'ends with': '~ends with', regex: '~regex' } as Record<string, string>)[plain] ?? plain : plain;
          return `\${${base}} ${used} '${arg[1] ?? arg[2] ?? ''}'`;
        }
      }
      return `\${${base}}${sub ? ' §substring§' : ''}`;
    })
    // after substring(): "== 'X'" only says the name contains X somewhere
    .replace(/§substring§\s*(==|=~|starts\s+with|startsWith|ends\s+with|endsWith|contains)/gi, 'contains')
    .replace(/§substring§/g, '');
}

/** A Camel simple expression that tests the file name, or null when it tests something else. */
export function parseFileCondition(rawExpr: string): FileCondition | null {
  const expr = normalizeCondition(rawExpr);
  const groups: Atom[][] = [];
  for (const orPart of expr.split(/\|\||\s+or\s+/i)) {
    const atoms: Atom[] = [];
    for (const andPart of orPart.split(/&&|\s+and\s+/i)) {
      for (const m of andPart.matchAll(ATOM)) {
        const rawOp = (m[5] as string).toLowerCase().replace(/\s+/g, ' ');
        const negate = rawOp.startsWith('not ') || rawOp.startsWith('!');
        const ci = rawOp.includes('~');
        const base = rawOp.replace(/^not |^!/, '').replace(/^~(?!~)/, '');
        const op: Atom['op'] =
          base === 'starts with' || base === 'startswith'
            ? 'starts'
            : base === 'ends with' || base === 'endswith'
              ? 'ends'
              : base === 'contains' || base === '~~'
                ? 'contains'
                : base === 'regex'
                  ? 'regex'
                  : base === 'in'
                    ? 'in'
                    : 'eq';
        atoms.push({ part: atomPart(m), op, value: m[6] ?? m[7] ?? '', negate, ci });
      }
    }
    if (atoms.length > 0) groups.push(atoms);
  }
  if (groups.length === 0) return null;
  return { groups, display: groups.map(displayGroup).join(' or ') };
}

function displayGroup(atoms: Atom[]): string {
  const pos = atoms.filter((a) => !a.negate && (a.part === 'name' || a.part === 'onlyname'));
  const start = pos.find((a) => a.op === 'starts');
  const end = pos.find((a) => a.op === 'ends') ?? atoms.find((a) => !a.negate && (a.part === 'ext' || a.part === 'ext1') && a.op === 'eq');
  const endText = end ? (end.part === 'ext' || end.part === 'ext1' ? `.${end.value.replace(/^\./, '')}` : end.value) : '';
  const rest = atoms.filter((a) => a !== start && a !== end);
  const parts: string[] = [];
  if (start || end) parts.push(`${start?.value ?? ''}*${endText}`);
  for (const a of rest) {
    const v =
      a.op === 'starts'
        ? `${a.value}*`
        : a.op === 'ends'
          ? `*${a.value}`
          : a.op === 'contains'
            ? `*${a.value}*`
            : a.op === 'regex'
              ? `/${a.value}/`
              : a.op === 'in'
                ? a.value.split(',').map((x) => x.trim()).join(' | ')
                : a.part === 'ext' || a.part === 'ext1'
                  ? `*.${a.value.replace(/^\./, '')}`
                  : a.value;
    parts.push(a.negate ? `not ${v}` : v);
  }
  return parts.join(' and ');
}

function namePart(file: string, part: NamePart): string {
  const only = file.slice(file.lastIndexOf('/') + 1);
  const first = only.indexOf('.', 1);
  const last = only.lastIndexOf('.');
  if (part === 'ext') return first > 0 ? only.slice(first + 1) : '';
  if (part === 'ext1') return last > 0 ? only.slice(last + 1) : '';
  if (part === 'noext') return first > 0 ? only.slice(0, first) : only;
  if (part === 'noext1') return last > 0 ? only.slice(0, last) : only;
  return part === 'onlyname' ? only : file;
}

export function conditionMatches(cond: FileCondition, fileName: string): boolean {
  return cond.groups.some((atoms) =>
    atoms.every((a) => {
      const raw = namePart(fileName, a.part);
      const v = a.ci ? raw.toLowerCase() : raw;
      const x = a.ci ? a.value.toLowerCase() : a.value;
      const hit =
        a.op === 'starts'
          ? v.startsWith(x)
          : a.op === 'ends'
            ? v.endsWith(x)
            : a.op === 'contains'
              ? v.includes(x)
              : a.op === 'regex'
                ? (safeRegex(a.value, a.ci ? 'i' : '')?.test(raw) ?? false)
                : a.op === 'in'
                  ? x.split(',').some((y) => y.trim() === v)
                  : v === x.replace(a.part === 'ext' || a.part === 'ext1' ? /^\./ : /$^/, '');
      return a.negate ? !hit : hit;
    }),
  );
}

// ---------------------------------------------------------------------------
// One <from> listing several file patterns: include=(INV|CRN)_.*\.csv, antInclude=INV_*.csv,CRN_*.csv
// ---------------------------------------------------------------------------

const MAX_ALTERNATIVES = 20;

/** Split a regex on `|` outside groups and classes. */
function topLevelSplit(re: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cls = false;
  let cur = '';
  for (let i = 0; i < re.length; i++) {
    const c = re[i] as string;
    if (c === '\\') {
      cur += c + (re[i + 1] ?? '');
      i++;
      continue;
    }
    if (cls) cls = c !== ']';
    else if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function expandRegex(re: string, budget: { n: number }): string[] {
  if (--budget.n < 0) return [re];
  const parts = topLevelSplit(re);
  if (parts.length > 1) return parts.flatMap((p) => expandRegex(p, budget));
  // expand the first plain group of alternatives, e.g. (INV|CRN) or (?:INV|CRN), when it is not repeated
  let cls = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i] as string;
    if (c === '\\') {
      i++;
      continue;
    }
    if (cls) {
      cls = c !== ']';
      continue;
    }
    if (c === '[') cls = true;
    if (c !== '(') continue;
    const open = re.startsWith('(?:', i) ? i + 3 : re[i + 1] === '?' ? -1 : i + 1;
    if (open < 0) continue;
    let j = open;
    let ok = true;
    let inCls = false;
    for (; j < re.length; j++) {
      const d = re[j] as string;
      if (d === '\\') {
        j++;
        continue;
      }
      if (inCls) inCls = d !== ']';
      else if (d === '[') inCls = true;
      else if (d === '(') {
        ok = false;
        break;
      } else if (d === ')') break;
    }
    if (!ok || j >= re.length) continue;
    const alts = topLevelSplit(re.slice(open, j));
    if (alts.length < 2 || /[*+?{]/.test(re[j + 1] ?? '')) continue;
    return alts.flatMap((a) => expandRegex(re.slice(0, i) + a + re.slice(j + 1), budget));
  }
  return [re];
}

/** The separate file patterns in one include/antInclude value (one element when it isn't a list). */
export function splitFilePatterns(pattern: string, kind: 'regex' | 'glob' | 'name'): string[] {
  if (kind === 'name' || /\{\{|\$\{/.test(pattern)) return [pattern];
  const parts = kind === 'glob' ? pattern.split(',').map((p) => p.trim()) : expandRegex(pattern, { n: MAX_ALTERNATIVES * 2 });
  const unique = [...new Set(parts.filter(Boolean))];
  return unique.length > 1 && unique.length <= MAX_ALTERNATIVES ? unique : [pattern];
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** What a test contributes to coverage: its node id and the strings that may name a trigger. */
export interface TestLabels {
  id: string;
  strings: string[];
  /**
   * The strings it is labelled with (decorators, markers, allure.* calls): trusted for any of a
   * trigger's names. Absent in scans stored before labels were told apart from body strings.
   */
  labels?: string[];
  /** Jira/Xray keys the test names (absent in scans stored before keys were collected). */
  keys?: string[];
}

/** A trigger as stored: the API fields plus its patterns with properties filled in, for matching later. */
export type StoredTrigger = Trigger & {
  match?: { pattern: string | null; condition: string | null; doneFile: string | null };
  /** Endpoints the trigger's route sends to (endpointKey form): direct:, seda:, jms:, kafka:… (absent in older scans). */
  calls?: string[];
};

/**
 * One name for an endpoint whoever writes it, so a route sending to it and the route consuming
 * it line up: `seda:orders?size=5` → seda:orders, `direct-vm:x` → direct:x, `jms:queue:ORDERS` → jms:ORDERS.
 * Null for endpoints that don't start a route here (log:, bean:, file:…).
 */
export function endpointKey(uri: string): string | null {
  const ep = parseEndpoint(unwrapMaster(uri));
  if (!ep) return null;
  const kind = kindOfScheme(ep.scheme);
  if (kind !== 'direct' && kind !== 'queue' && kind !== 'kafka') return null;
  const scheme = ep.scheme === 'direct-vm' ? 'direct' : ep.scheme;
  const path = ep.path.replace(/^\/\//, '').replace(/^(queue|topic):/i, '').trim();
  return path && !PROPERTY_ONLY.test(path) ? `${scheme}:${path}` : null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
/** fileName / doneFileName may use the file language (INV_${date:now:yyyyMMdd}.csv, ${file:name}.done): any value there. */
/** Camel compares fileName / doneFileName exactly (name.equals), so case counts. */
const fileLanguageRegex = (pattern: string): RegExp | null => safeRegex(pattern.split(/\$\{[^}]*\}/).map(escapeRe).join('.*'), '');

/** Does a file name (a label like INV_20260101.csv) start this file trigger? */
function fileTester(t: StoredTrigger): ((fileName: string) => boolean) | null {
  if (t.kind !== 'file') return null;
  const m = t.match;
  const testers: Array<(f: string) => boolean> = [];
  if (t.patternKind === 'condition' && (m?.condition ?? t.condition)) {
    const cond = parseFileCondition(m?.condition ?? (t.condition as string));
    // every alternative must name something specific: "contains 'sp'" or "!= 'X'" alone matches nearly any label
    if (cond && cond.groups.every((g) => g.some((x) => !x.negate && x.value.length >= 3))) testers.push((f) => conditionMatches(cond, f));
  } else if (m?.pattern ?? t.filePattern) {
    const pattern = (m?.pattern ?? t.filePattern) as string;
    const re = t.patternKind === 'regex' ? safeRegex(pattern) : t.patternKind === 'glob' ? antRegex(pattern, !/[?&]antFilterCaseSensitive=false\b/i.test(t.resolvedUri)) : fileLanguageRegex(pattern);
    if (re) testers.push((f) => re.test(f));
  }
  const done = m?.doneFile ?? t.doneFile;
  if (done) {
    const re = fileLanguageRegex(done);
    if (re) testers.push((f) => re.test(f));
  }
  // a pattern that accepts any file (include=.*, "not X", *.csv) says nothing about which test covers it
  const probes = broadProbes([m?.pattern, t.filePattern, m?.condition, t.condition, done]);
  const selective = testers.filter((x) => probes.filter((p) => x(p)).length < 2);
  return selective.length ? (f) => selective.some((x) => x(f)) : null;
}

/** Made-up file names: a pattern accepting most of them is too broad to link a test by file name. */
const BROAD_PROBES = ['zq_probe_7x3.tmp', 'QZ9PROBE.XYZ', 'probe-file.txt'];

/**
 * The probes plus the same made-up names with each extension the pattern names
 * (`.*\.csv` → zq_probe_7x3.csv…), so an extension-only pattern counts as broad too.
 */
export function broadProbes(patterns: ReadonlyArray<string | null | undefined>): string[] {
  const exts = new Set<string>();
  for (const p of patterns) {
    if (!p) continue;
    const plain = p.replace(/\\/g, '');
    for (const m of plain.matchAll(/\.([A-Za-z0-9]{1,8})(?![A-Za-z0-9])/g)) exts.add((m[1] as string).toLowerCase());
    for (const m of plain.matchAll(/\.\(\??:?([A-Za-z0-9|]+)\)/g)) for (const e of (m[1] as string).split('|')) if (e) exts.add(e.toLowerCase());
    // ends with 'csv' in a condition (${file:name} ends with '.csv' / ext == 'csv')
    for (const m of plain.matchAll(/'\.?([A-Za-z0-9]{1,8})'/g)) exts.add((m[1] as string).toLowerCase());
  }
  const out = [...BROAD_PROBES];
  for (const e of exts) out.push(`zq_probe_7x3.${e}`, `QZ9PROBE.${e.toUpperCase()}`, `probe-file.${e}`);
  return out;
}

/**
 * What a name is, for how much a body string must look like it before it counts:
 *   id    the route id
 *   name  another name for it: a schedule's, a branch's job, a queue/topic/direct endpoint's, a REST path
 *   file  a file pattern or trigger file name
 *   uri   the endpoint as written (seda:orders, direct:invoiceJob): specific by itself
 */
export type NameKind = 'id' | 'name' | 'file' | 'uri';

/** Names a test can use for a trigger, normalized, with their kind. */
export function triggerNames(t: StoredTrigger): Array<{ n: string; kind: NameKind }> {
  const names: Array<{ n: string; kind: NameKind }> = [];
  const add = (v: string | null | undefined, kind: NameKind) => {
    const n = v ? norm(v) : '';
    if (n) names.push({ n, kind });
  };
  add(t.routeId, 'id');
  if (t.kind === 'schedule') add(parseEndpoint(t.resolvedUri)?.path.split('/').filter(Boolean).pop(), 'name');
  // a <choice> branch's job: direct:invoiceJob ↔ label "invoiceJob" (or "direct:invoiceJob")
  if (t.target) {
    add(parseEndpoint(t.target)?.path.split(/[/?]/).filter(Boolean).pop(), 'name');
    add(t.target.split('?')[0], 'uri');
  }
  for (const v of endpointNames(t)) add(v, 'name');
  if (t.kind !== 'file' && t.kind !== 'property' && !PROPERTY_ONLY.test(t.resolvedUri)) add(t.resolvedUri.split('?')[0]?.replace(/^([\w+.-]+):\/\//, '$1:'), 'uri');
  if (t.kind === 'file') for (const v of [t.filePattern, t.match?.pattern, t.doneFile, t.match?.doneFile]) add(v, 'file');
  const seen = new Set<string>();
  return names.filter((x) => !seen.has(`${x.kind}\0${x.n}`) && !!seen.add(`${x.kind}\0${x.n}`));
}

/**
 * Does a string in a test's body (not one it is labelled with) say enough to link it by this
 * name? Labels (decorators, markers, allure.*) link by any name. A body is full of short
 * words ("orders", "start", "load"), so there a name has to be distinctive: several words
 * (invoice-load, parseInvoice, api/orders) or a number (OSCAR150) — or, for a route id or a
 * file name, at least 8 characters. The endpoint as written (seda:orders) always counts.
 */
export function bodyCanName(n: string, kind: NameKind): boolean {
  if (kind === 'uri') return true;
  const core = n.replace(/^[/-]+|[/-]+$/g, '');
  const several = core.length >= 5 && /[-\d/:]/.test(core);
  if (several) return true;
  return (kind === 'id' || kind === 'file') && core.length >= 8;
}
/**
 * Names for a route started by another route, a queue, Kafka or HTTP: the endpoint's name
 * (direct:invoiceJob → invoiceJob, jms:queue:ORDERS → ORDERS, kafka:invoices → invoices) or
 * the HTTP path (netty-http:http://0.0.0.0:8080/api/orders → /api/orders).
 */
function endpointNames(t: StoredTrigger): string[] {
  if (t.kind !== 'direct' && t.kind !== 'queue' && t.kind !== 'kafka' && t.kind !== 'rest') return [];
  const ep = parseEndpoint(t.resolvedUri);
  if (!ep || PROPERTY_ONLY.test(ep.path)) return [];
  if (t.kind === 'rest') {
    const url = /^[a-z][\w+.-]*:\/\/[^/]*(\/[^?#]*)?/i.exec(ep.path);
    let p: string;
    if (url) p = url[1] ?? '';
    else if (ep.scheme === 'rest' || ep.scheme === 'rest-api') {
      // rest:verb:path[:uriTemplate]
      const [path = '', template = ''] = ep.path.replace(/^(get|post|put|delete|patch|head|options):/i, '').split(':');
      p = `${path.replace(/\/$/, '')}/${template.replace(/^\//, '')}`;
    } else if (ep.scheme === 'http' || ep.scheme === 'https' || /^[^/]*:\d+(\/|$)/.test(ep.path)) p = ep.path.replace(/^[^/]*/, ''); // host:port/path
    else p = ep.path;
    if (ep.params.contextPath) p = `${ep.params.contextPath.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
    p = p.replace(/\/+$/, '');
    if (!p || p === '/' || p.includes('{{')) return [];
    const slash = p.startsWith('/') ? p : `/${p}`;
    return [slash, slash.slice(1)];
  }
  const name = ep.path.split(/[/:]/).filter(Boolean).pop();
  return name && !name.includes('{{') ? [name] : [];
}

const FILE_NAME_LIKE = /^[\w.-]+\.\w+$/;

/**
 * Which tests cover which triggers (by trigger key). Exact names go through an index; only
 * strings that look like file names (INV_20260101.csv) are tried against each file trigger's
 * patterns. A string a test is labelled with links by any of the trigger's names; a string
 * from its body only by a distinctive one (see bodyCanName).
 */
export function coverTriggers(triggers: readonly StoredTrigger[], tests: readonly TestLabels[]): Map<string, TriggerCoverage[]> {
  const byName = new Map<string, Array<{ test: string; via: string; label: boolean }>>();
  const fileLabels: Array<{ test: string; via: string }> = [];
  for (const t of tests) {
    // scans stored before labels were told apart: every string counts as a label (as it did then)
    const labels = t.labels ? new Set(t.labels) : null;
    for (const s of t.strings) {
      const n = norm(s);
      if (!n) continue;
      const list = byName.get(n) ?? [];
      list.push({ test: t.id, via: s, label: labels ? labels.has(s) : true });
      byName.set(n, list);
      if (FILE_NAME_LIKE.test(s.trim())) fileLabels.push({ test: t.id, via: s.trim() });
    }
  }
  const out = new Map<string, TriggerCoverage[]>();
  for (const t of triggers) {
    const hits = new Map<string, string>();
    for (const { n, kind } of triggerNames(t)) {
      const body = bodyCanName(n, kind);
      for (const h of byName.get(n) ?? []) if (!hits.has(h.test) && (h.label || body)) hits.set(h.test, h.via);
    }
    const tester = fileLabels.length ? fileTester(t) : null;
    if (tester) for (const f of fileLabels) if (!hits.has(f.test) && tester(f.via)) hits.set(f.test, f.via);
    out.set(
      t.key,
      [...hits].map(([test, via]) => ({ test, via, testCaseId: null })),
    );
  }
  return out;
}

export interface ScanInput {
  xml: ReadonlyArray<{ path: string; text: string }>;
  properties: ReadonlyArray<{ path: string; text: string }>;
  tests: ReadonlyArray<{ path: string; text: string }>;
}

/** A route the scan read but doesn't count, and why. */
export interface SkippedRoute {
  routeId: string | null;
  module: string | null;
  file: string;
  line: number;
  reason: string;
}

export interface ScanOutput {
  /** Routes read but not counted: what starts them is not a trigger, a template, a copy… */
  skippedRoutes: SkippedRoute[];
  triggers: StoredTrigger[];
  /** Tests found in the uploaded pytest files, for matching against any branch's triggers later. */
  tests: TestLabels[];
  testsFound: number;
  otherRoutes: number;
  warnings: string[];
}

/**
 * The module a route file belongs to: the folder under `resources/` in a multi-module
 * layout (`src/main/resources/<module>/routes/x.xml`), else the file's folder. Route ids
 * only have to be unique within a Camel context, so the same id in two modules is two routes.
 */
export function moduleOf(file: string): string | null {
  const segs = file.split('/');
  const r = segs.lastIndexOf('resources');
  if (r >= 0) return r + 2 < segs.length ? (segs[r + 1] as string) : null;
  return segs.length > 1 ? segs.slice(0, -1).join('/') : null;
}

const ms = (v: string): string => (/^\d+$/.test(v) ? `${v} ms` : v);

function describeSchedule(scheme: string, p: Record<string, string>): string | null {
  if (p.cron) return p.cron;
  if (p.schedule) return p.schedule;
  const every = p.period ?? p.delay ?? p['trigger.repeatInterval'];
  if (every) return `every ${ms(every)}`;
  if ((scheme === 'quartz' || scheme === 'quartz2') && p['trigger.repeatCount'] === '0') return 'once, at start-up';
  if (scheme === 'timer' && p.repeatCount === '1') return 'once, at start-up';
  if (scheme === 'timer') return 'every 1000 ms';
  if (scheme === 'scheduler') return 'every 500 ms';
  return null;
}

export function scanRepository(input: ScanInput): ScanOutput {
  const warnings: string[] = [];
  const props = buildPropertyIndex(input.properties);
  /** `<endpoint id uri>` by id: ids are per Camel context, so the same file's, else the same module's, else the only one. */
  const endpointDefs = new Map<string, Array<{ file: string; module: string | null; uri: string }>>();
  const raw: RawRoute[] = [];
  for (const f of input.xml) {
    const r = scanCamelXml(f.path, f.text);
    raw.push(...r.routes);
    for (const [id, uri] of r.endpoints) endpointDefs.set(id, [...(endpointDefs.get(id) ?? []), { file: f.path, module: moduleOf(f.path), uri }]);
  }
  const endpointFor = (ref: string, file: string): string | undefined => {
    const defs = endpointDefs.get(ref) ?? [];
    const module = moduleOf(file);
    return (defs.find((d) => d.file === file) ?? (defs.filter((d) => d.module === module).length === 1 ? defs.find((d) => d.module === module) : undefined) ?? (defs.length === 1 ? defs[0] : undefined))?.uri;
  };
  /** Route id → its inputs as written, to tell a copy of a route (counted once) from a different route reusing the id. */
  const firstInputs = new Map<string, string>();

  const triggers: StoredTrigger[] = [];
  const usedKeys = new Set<string>();
  const routeIds = new Map<string, string>();
  const uniqueKey = (key: string): string => {
    let k = key;
    for (let n = 2; usedKeys.has(k); n++) k = `${key}~${n}`;
    usedKeys.add(k);
    return k;
  };
  let otherRoutes = 0;
  const skippedRoutes: SkippedRoute[] = [];
  for (const r of raw) {
    const module = moduleOf(r.file);
    const skip = (reason: string) => skippedRoutes.push({ routeId: r.routeId, module, file: r.file, line: r.line, reason });
    if (r.template) {
      skip('a <routeTemplate>: not a route until something instantiates it');
      continue;
    }
    if (r.routeId) {
      const id = `${module ?? ''}\0${r.routeId}`;
      const first = routeIds.get(id);
      const inputs = JSON.stringify(r.inputs.map((x) => x.uri ?? `ref:${x.ref}`));
      if (first) {
        // Camel won't start two routes with one id in a context: an identical copy is counted once
        const copy = firstInputs.get(id) === inputs;
        warnings.push(`route id "${r.routeId}" is defined more than once${module ? ` in ${module}` : ''} (${r.file}:${r.line}, first at ${first})${copy ? ': the same route, counted once' : ''}`);
        if (copy) {
          skip(`an identical copy of the route at ${first}: counted once`);
          continue;
        }
      } else {
        routeIds.set(id, `${r.file}:${r.line}`);
        firstInputs.set(id, inputs);
      }
    }
    if (r.inputs.length === 0) {
      skip('has no <from>');
      continue;
    }
    const conditions = r.conditions
      .map((c) => ({ c, resolved: resolvePlaceholders(normalizeCondition(c.expr), props, r.file) }))
      .map((x) => ({ ...x, parsed: parseFileCondition(x.resolved.firstVariant) }))
      .filter((x): x is { c: RawCondition; resolved: Resolved; parsed: FileCondition } => x.parsed !== null);
    let routeHasTrigger = false;
    // the routes this one hands work to (direct:, seda:, jms:, kafka:), for "run via a tested route"
    const calls = [...new Set((r.calls ?? []).map((u) => endpointKey(resolvePlaceholders(u, props, r.file).firstVariant)).filter((k): k is string => k !== null))];
    // the marker file a load route deletes when it is done: its trigger file when the <from> names none
    const marker = r.markers[0] ? resolvePlaceholders(r.markers[0], props, r.file) : null;
    r.inputs.forEach((inp, idx) => {
      // <from ref="x"/> and the ref: component (<from uri="ref:x"/>) both name an <endpoint id="x">
      const refId = inp.ref ?? /^\s*ref:(?:\/\/)?([^?\s]+)\s*$/.exec(inp.uri ?? '')?.[1];
      const uri = (refId ? endpointFor(refId, r.file) : undefined) ?? inp.uri ?? undefined;
      if (!uri) {
        warnings.push(`${r.file}:${inp.line}: <from> without a uri${inp.ref ? ` (endpoint "${inp.ref}" not found)` : ''}`);
        return;
      }
      const filled = resolvePlaceholders(uri, props, r.file);
      const resolved = { ...filled, text: unwrapMaster(filled.text), firstVariant: unwrapMaster(filled.firstVariant) };
      let ep = parseEndpoint(resolved.firstVariant);
      let kind = ep ? kindOfScheme(ep.scheme) : null;
      const fromProperty = PROPERTY_ONLY.test(uri);
      if (fromProperty && (!ep || !kind) && !PROPERTY_ONLY.test(resolved.firstVariant)) {
        // the property is set, to something that starts no route (bean:, stub:, empty): say so rather than drop it silently
        warnings.push(`${r.file}:${inp.line}: route ${r.routeId ? `"${r.routeId}" ` : ''}starts from ${uri.trim()} = "${resolved.firstVariant.trim().slice(0, 80)}", not a trigger`);
        return;
      }
      if (!ep) {
        // the whole URI is a property no properties file fills in: an SFTP/FTP poll when its key says so, else of unknown kind
        const only = PROPERTY_ONLY.exec(resolved.firstVariant);
        if (!only) return;
        const guessed = guessFileScheme(only[1] ?? only[2] ?? '');
        kind = guessed ? 'file' : 'property';
        ep = { scheme: guessed ?? 'property', path: only[0].trim(), params: {} };
      }
      if (!kind) return;
      routeHasTrigger = true;
      // fields shown to people come from the single-valued resolution, so per-environment values stay visible as placeholders
      const shown = parseEndpoint(resolved.text) ?? ep;
      const p = shown.params;
      const id = r.routeId ?? `${r.file}#${uri}`;
      const baseKey = `${module && r.routeId ? `${module}/` : ''}${id}${r.inputs.length > 1 ? `#${idx + 1}` : ''}`;
      const base: StoredTrigger = {
        ...(calls.length ? { calls } : {}),
        key: baseKey,
        routeId: r.routeId,
        module,
        kind,
        scheme: ep.scheme,
        uri,
        resolvedUri: resolved.text,
        directory: kind === 'file' ? shown.path || null : null,
        filePattern: null,
        patternKind: null,
        condition: null,
        target: null,
        doneFile: kind === 'file' ? (p.doneFileName ?? marker?.text ?? null) : null,
        input: idx + 1,
        schedule: kind === 'schedule' ? describeSchedule(ep.scheme, p) : null,
        sourceFile: r.file,
        line: inp.line,
        unresolved: resolved.unresolved,
        coveredBy: [],
        match: { pattern: null, condition: null, doneFile: kind === 'file' ? (ep.params.doneFileName ?? marker?.firstVariant ?? null) : null },
      };
      if (kind !== 'file') {
        triggers.push({ ...base, key: uniqueKey(baseKey) });
        return;
      }
      // one file route that hands each file name to its own job: one trigger per branch
      if (conditions.length > 0) {
        for (const { c, resolved: rc, parsed } of conditions) {
          triggers.push({
            ...base,
            key: uniqueKey(`${baseKey}::${parsed.display}`),
            filePattern: parsed.display,
            patternKind: 'condition',
            condition: c.expr,
            target: c.target,
            line: c.line,
            ...(() => {
              const own = [...new Set([...calls, ...(c.calls ?? []).map((u) => endpointKey(resolvePlaceholders(u, props, r.file).firstVariant)).filter((k): k is string => k !== null)])];
              return own.length ? { calls: own } : {};
            })(),
            unresolved: [...base.unresolved, ...rc.unresolved.filter((u) => !base.unresolved.some((b) => b.key === u.key))],
            match: { ...base.match!, condition: rc.firstVariant },
          });
        }
        return;
      }
      const which = p.include !== undefined ? 'include' : p.antInclude !== undefined ? 'antInclude' : p.fileName !== undefined ? 'fileName' : null;
      if (which === null) {
        triggers.push({ ...base, key: uniqueKey(baseKey) });
        return;
      }
      const patternKind = which === 'include' ? 'regex' : which === 'antInclude' ? 'glob' : 'name';
      const parts = splitFilePatterns(p[which] as string, patternKind);
      for (const part of parts) {
        triggers.push({
          ...base,
          key: uniqueKey(parts.length > 1 ? `${baseKey}::${part}` : baseKey),
          filePattern: part,
          patternKind,
          // split parts have no placeholders, so they already are the resolved pattern
          match: { ...base.match!, pattern: parts.length > 1 ? part : (ep.params[which] ?? part) },
        });
      }
    });
    if (!routeHasTrigger) {
      otherRoutes++;
      const first = r.inputs[0];
      const raw = first?.uri ?? (first?.ref ? `ref ${first.ref}` : '');
      const filled = first?.uri ? resolvePlaceholders(first.uri, props, r.file).firstVariant.trim() : raw;
      skip(`starts from ${filled.split('?')[0]?.slice(0, 120)}${filled !== raw && raw ? ` (${raw.trim().slice(0, 80)})` : ''}, which is not a trigger type (file, schedule, direct, queue, Kafka, REST)`);
    }
  }

  const tests: TestLabels[] = scanPytestFiles(input.tests).map((t) => ({ id: t.id, strings: t.strings, labels: t.labels, keys: t.keys }));
  const coverage = coverTriggers(triggers, tests);
  for (const t of triggers) t.coveredBy = coverage.get(t.key) ?? [];
  return { skippedRoutes, triggers, tests, testsFound: tests.length, otherRoutes, warnings };
}
