/**
 * Scans a repository snapshot for Camel route triggers and the pytest tests that
 * cover them. Pure functions, no I/O: the upload code hands in file contents.
 *
 * - Routes come from Camel XML (`<route id="…"><from uri="…"/>`, any namespace
 *   prefix, `<from ref>` → `<endpoint id uri>`). Only routes started by a file
 *   (file/ftp/ftps/sftp/smb) or a schedule (quartz/cron/timer/scheduler) are triggers.
 * - `{{key}}` / `${key}` placeholders (with `:default`) are filled in from every
 *   `.properties` file; a key with different values in different files (one file
 *   per environment) is reported with each value instead of guessing.
 * - A test covers a trigger when a string in its decorators (Allure labels, pytest
 *   markers) or an `allure.dynamic.*` call in its body names the route id, the
 *   schedule's name, or a file the trigger would pick up.
 */
import type { Trigger, TriggerCoverage } from '@ptd/shared';

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
const CAMEL_LANGUAGE = /^(date|file|header|headers|exchangeProperty|body|bodyAs|in|out|bean|sys|sysenv|env|exchangeId|id|messageTimestamp|camelId|routeId|random|uuid|type|ref|properties|exception)\b/;

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
        // `{{env:NAME}}`-style functions and `${date:now:yyyyMMdd}` (Camel file language) are not property keys
        const key = colon >= 0 ? body.slice(0, colon) : body;
        const fallback = colon >= 0 ? body.slice(colon + 1) : null;
        const values = nearest(props.get(key), near);
        const distinct = [...new Set((values ?? []).map((v) => v.value))];
        if (distinct.length === 1) {
          changed = true;
          return distinct[0] as string;
        }
        if (distinct.length === 0) {
          if (fallback !== null && a !== undefined) {
            changed = true;
            return fallback;
          }
          // ${…} can also be Camel's file/simple language (e.g. ${date:now:yyyyMMdd}): not a missing property
          if ((a !== undefined || !CAMEL_LANGUAGE.test(key)) && !unresolved.has(key)) unresolved.set(key, { key, values: [] });
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
}

export interface RawRoute {
  routeId: string | null;
  file: string;
  line: number;
  /** `<from>`s in order (usually one). */
  inputs: RawInput[];
  conditions: RawCondition[];
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
  const branches: RawCondition[] = [];
  let lineAt = 0;
  let line = 1;
  const lineOf = (offset: number): number => {
    for (; lineAt < offset; lineAt++) if (text.charCodeAt(lineAt) === 10) line++;
    return line;
  };
  for (const m of text.matchAll(TAG)) {
    const closing = m[1] === '/';
    const name = m[2] as string;
    const selfClosing = m[4] === '/';
    const route = stack[stack.length - 1];
    if (name === 'route') {
      if (closing) stack.pop();
      else if (!selfClosing) {
        const a = attrs(m[3] ?? '');
        const r: RawRoute = { routeId: a.id ?? a.routeId ?? null, file, line: lineOf(m.index ?? 0), inputs: [], conditions: [] };
        routes.push(r);
        stack.push(r);
      }
      continue;
    }
    if (name === 'when' || name === 'filter') {
      if (!route) continue;
      if (closing) {
        const b = branches.pop();
        if (b?.expr) route.conditions.push(b);
      } else if (!selfClosing) branches.push({ kind: name, expr: '', target: null, line: lineOf(m.index ?? 0) });
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
    }
  }
  return { routes, endpoints };
}

// ---------------------------------------------------------------------------
// pytest files
// ---------------------------------------------------------------------------

export interface ScannedTest {
  /** pytest node id: `path::Class::test_name`. */
  id: string;
  file: string;
  cls: string | null;
  name: string;
  /**
   * Candidate strings: decorator string arguments and marker names (also from
   * `pytestmark`), and the string literals in the test body (allure.dynamic.* labels,
   * a trigger file the test drops, a route id it starts).
   */
  strings: string[];
}

const STRING_LIT = /[rRbBuUfF]{0,2}("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
/** Decorators whose string arguments are data, not labels. */
const IGNORED_DECORATORS = /^@pytest\.mark\.(parametrize|usefixtures|skip|skipif|xfail|filterwarnings|timeout|flaky|order|dependency)\b|^@pytest\.fixture\b|^@(staticmethod|classmethod|property)\b/;

function strings(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(STRING_LIT)) {
    const lit = m[1] as string;
    const q = lit.startsWith('"""') || lit.startsWith("'''") ? 3 : 1;
    const v = lit
      .slice(q, -q)
      .replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
      .trim();
    if (v && v.length <= 300) out.push(v);
  }
  return out;
}

function decoratorStrings(text: string): string[] {
  if (IGNORED_DECORATORS.test(text)) return [];
  const out = strings(text);
  // a bare marker (`@pytest.mark.invoice_load`) names something by itself
  const marker = /^@pytest\.mark\.(\w+)/.exec(text);
  if (marker) out.push(marker[1] as string);
  return out;
}

/** `pytestmark = pytest.mark.x` / `[pytest.mark.x, pytest.mark.y("z")]`: marker names and their string arguments. */
function pytestmarkStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/pytest\.mark\.(\w+)\s*(\((?:[^()]|\([^()]*\))*\))?/g)) {
    if (IGNORED_DECORATORS.test(`@pytest.mark.${m[1]}`)) continue;
    out.push(m[1] as string, ...strings(m[2] ?? ''));
  }
  return out;
}

/** Body string literals worth matching: short, single-line values (not docstrings or SQL). */
const bodyStrings = (body: string): string[] => strings(body).filter((v) => v.length <= 120 && !v.includes('\n'));

const indentOf = (s: string): number => s.length - s.trimStart().length;
const parenDepth = (s: string): number => {
  let d = 0;
  for (const c of s.replace(STRING_LIT, '""')) {
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return d;
};

export const isPytestFile = (path: string): boolean => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path);

/** Test functions and the strings that could label them (indentation-based; no Python parser needed). */
export function scanPytestFile(file: string, source: string): ScannedTest[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const tests: ScannedTest[] = [];
  let pending: string[] = [];
  let cls: { name: string; indent: number; strings: string[] } | null = null;
  const moduleMarks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);
    if (cls && indent <= cls.indent && !trimmed.startsWith('@')) cls = null;
    if (/^pytestmark\s*=/.test(trimmed)) {
      let text = trimmed;
      while (parenDepth(text) > 0 && i + 1 < lines.length) text += ` ${(lines[++i] as string).trim()}`;
      const marks = pytestmarkStrings(text);
      if (cls && indent > cls.indent) cls.strings.push(...marks);
      else if (indent === 0) moduleMarks.push(...marks);
      pending = [];
      continue;
    }
    if (trimmed.startsWith('@')) {
      let text = trimmed;
      while (parenDepth(text) > 0 && i + 1 < lines.length) text += ` ${(lines[++i] as string).trim()}`;
      pending.push(...decoratorStrings(text));
      continue;
    }
    const c = /^class\s+(\w+)/.exec(trimmed);
    if (c) {
      cls = /^Test/.test(c[1] as string) ? { name: c[1] as string, indent, strings: pending } : null;
      pending = [];
      continue;
    }
    const d = /^(?:async\s+)?def\s+(test\w*)\s*\(/.exec(trimmed);
    if (d) {
      const inClass = cls !== null && indent > cls.indent;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] as string;
        if (l.trim() && indentOf(l) <= indent) break;
        body.push(l);
      }
      const name = d[1] as string;
      tests.push({
        id: inClass && cls ? `${file}::${cls.name}::${name}` : `${file}::${name}`,
        file,
        cls: inClass && cls ? cls.name : null,
        name,
        strings: [...new Set([...pending, ...(inClass && cls ? cls.strings : []), ...bodyStrings(body.join('\n'))])],
      });
      pending = [];
      i = j - 1;
      continue;
    }
    pending = [];
  }
  // module-level pytestmark applies to every test in the file, wherever it is written
  if (moduleMarks.length) for (const t of tests) t.strings = [...new Set([...t.strings, ...moduleMarks])];
  return tests;
}

/** allure-pytest's fullName for a scanned test: `tests.routes.test_invoice.TestLoad#test_x`. */
export function allureFullName(t: ScannedTest): string {
  const mod = t.file.replace(/\.py$/, '').split('/').filter(Boolean).join('.');
  return `${mod}${t.cls ? `.${t.cls}` : ''}#${t.name}`;
}

// ---------------------------------------------------------------------------
// Triggers and coverage
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_.-]+/g, '-');

/**
 * Camel `include` is a Java regex. Only simple patterns are tried (no nested
 * quantifiers, bounded length) so an uploaded pattern can't hang the server.
 */
function safeRegex(pattern: string): RegExp | null {
  if (pattern.length > 300 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /\\[1-9]|\(\?[<!=]/.test(pattern)) return null;
  try {
    return new RegExp(`^(?:${pattern})$`, 'i');
  } catch {
    return null;
  }
}

function antRegex(glob: string): RegExp {
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
  return new RegExp(`^(?:${re})$`, 'i');
}

// ---------------------------------------------------------------------------
// Conditions on the file name (<choice><when><simple>${file:name} starts with 'INV_'</simple>…)
// ---------------------------------------------------------------------------

type NamePart = 'name' | 'onlyname' | 'noext' | 'ext';
interface Atom {
  part: NamePart;
  op: 'starts' | 'ends' | 'contains' | 'regex' | 'eq' | 'eqi' | 'in';
  value: string;
  negate: boolean;
}
export interface FileCondition {
  /** OR of AND-groups. */
  groups: Atom[][];
  display: string;
}

const FILE_REF =
  /\$\{\s*(?:file:(name|onlyname)(\.noext)?|file:(ext|name\.ext)|(?:in\.)?headers?(?:\.|\[\s*['"]?)CamelFileName(Only)?(?:['"]?\s*\])?)\s*\}/i;
const ATOM = new RegExp(
  `${FILE_REF.source}\\s*(not\\s+starts\\s+with|starts\\s+with|startsWith|not\\s+ends\\s+with|ends\\s+with|endsWith|not\\s+contains|contains|not\\s+regex|regex|=~|==|!=|not\\s+in|in)\\s*(?:'([^']*)'|"([^"]*)")`,
  'gi',
);

function atomPart(m: RegExpMatchArray): NamePart {
  if (m[3]) return 'ext';
  if (m[2]) return 'noext';
  if (m[1]?.toLowerCase() === 'onlyname' || m[4]) return 'onlyname';
  return 'name';
}

const NAME_BASE = String.raw`(?:in\.)?headers?(?:\.|\[\s*['"]?)CamelFileName(?:Only)?(?:['"]?\s*\])?|file:(?:name|onlyname)(?:\.noext)?`;
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
      for (const m of chain.matchAll(/\.(\w+)\(((?:[^()'"]|'[^']*'|"[^"]*")*)\)/g)) {
        const name = (m[1] as string).toLowerCase();
        if (name === 'substring' || name === 'substr') sub = true;
        const op = BOOLEAN_METHODS[name];
        if (op) {
          const arg = /^\s*(?:'([^']*)'|"([^"]*)")\s*$/.exec(m[2] ?? '');
          if (!arg) return `\${${base}}`;
          return `\${${base}} ${sub && op !== 'regex' ? 'contains' : op} '${arg[1] ?? arg[2] ?? ''}'`;
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
        const negate = rawOp.startsWith('not ') || rawOp === '!=';
        const base = rawOp.replace(/^not /, '');
        const op: Atom['op'] =
          base === 'starts with' || base === 'startswith'
            ? 'starts'
            : base === 'ends with' || base === 'endswith'
              ? 'ends'
              : base === 'contains'
                ? 'contains'
                : base === 'regex'
                  ? 'regex'
                  : base === '=~'
                    ? 'eqi'
                    : base === 'in'
                      ? 'in'
                      : 'eq';
        atoms.push({ part: atomPart(m), op, value: m[6] ?? m[7] ?? '', negate });
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
  const end = pos.find((a) => a.op === 'ends') ?? atoms.find((a) => !a.negate && a.part === 'ext' && (a.op === 'eq' || a.op === 'eqi'));
  const endText = end ? (end.part === 'ext' ? `.${end.value.replace(/^\./, '')}` : end.value) : '';
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
                : a.part === 'ext'
                  ? `*.${a.value.replace(/^\./, '')}`
                  : a.value;
    parts.push(a.negate ? `not ${v}` : v);
  }
  return parts.join(' and ');
}

function namePart(file: string, part: NamePart): string {
  const only = file.slice(file.lastIndexOf('/') + 1);
  const dot = only.lastIndexOf('.');
  if (part === 'ext') return dot > 0 ? only.slice(dot + 1) : '';
  if (part === 'noext') return dot > 0 ? only.slice(0, dot) : only;
  return part === 'onlyname' ? only : file;
}

export function conditionMatches(cond: FileCondition, fileName: string): boolean {
  return cond.groups.some((atoms) =>
    atoms.every((a) => {
      const v = namePart(fileName, a.part).toLowerCase();
      const x = a.value.toLowerCase();
      const hit =
        a.op === 'starts'
          ? v.startsWith(x)
          : a.op === 'ends'
            ? v.endsWith(x)
            : a.op === 'contains'
              ? v.includes(x)
              : a.op === 'regex'
                ? (safeRegex(a.value)?.test(namePart(fileName, a.part)) ?? false)
                : a.op === 'in'
                  ? x.split(',').some((y) => y.trim() === v)
                  : v === x.replace(a.part === 'ext' ? /^\./ : /$^/, '');
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
}

/** A trigger as stored: the API fields plus its patterns with properties filled in, for matching later. */
export type StoredTrigger = Trigger & {
  match?: { pattern: string | null; condition: string | null; doneFile: string | null };
};

const escapeRe = (s: string): string => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
/** fileName / doneFileName may use the file language (INV_${date:now:yyyyMMdd}.csv, ${file:name}.done): any value there. */
const fileLanguageRegex = (pattern: string): RegExp | null => safeRegex(pattern.split(/\$\{[^}]*\}/).map(escapeRe).join('.*'));

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
    const re = t.patternKind === 'regex' ? safeRegex(pattern) : t.patternKind === 'glob' ? antRegex(pattern) : fileLanguageRegex(pattern);
    if (re) testers.push((f) => re.test(f));
  }
  const done = m?.doneFile ?? t.doneFile;
  if (done) {
    const re = fileLanguageRegex(done);
    if (re) testers.push((f) => re.test(f));
  }
  // a pattern that accepts any file (include=.*, "not X") says nothing about which test covers it
  const selective = testers.filter((x) => BROAD_PROBES.filter((p) => x(p)).length < 2);
  return selective.length ? (f) => selective.some((x) => x(f)) : null;
}

/** Made-up file names: a pattern accepting most of them is too broad to link a test by file name. */
const BROAD_PROBES = ['zq_probe_7x3.tmp', 'QZ9PROBE.XYZ', 'probe-file.txt'];

/** Names a label can use for a trigger: route id, schedule name, the job a branch sends files to, file/trigger-file name. */
function triggerNames(t: StoredTrigger): string[] {
  const names: string[] = [];
  if (t.routeId) names.push(t.routeId);
  if (t.kind === 'schedule') {
    const name = parseEndpoint(t.resolvedUri)?.path.split('/').filter(Boolean).pop();
    if (name) names.push(name);
  }
  // a <choice> branch's job: direct:invoiceJob ↔ label "invoiceJob"
  const job = t.target ? parseEndpoint(t.target)?.path.split(/[/?]/).filter(Boolean).pop() : null;
  if (job) names.push(job);
  if (t.kind === 'file') {
    for (const v of [t.filePattern, t.match?.pattern, t.doneFile, t.match?.doneFile]) if (v) names.push(v);
  }
  return [...new Set(names.map(norm).filter(Boolean))];
}

const FILE_NAME_LIKE = /^[\w.-]+\.\w+$/;

/**
 * Which tests cover which triggers (by trigger key). Exact names go through an
 * index; only labels that look like file names (INV_20260101.csv) are tested
 * against each file trigger's patterns.
 */
export function coverTriggers(triggers: readonly StoredTrigger[], tests: readonly TestLabels[]): Map<string, TriggerCoverage[]> {
  const byName = new Map<string, Array<{ test: string; via: string }>>();
  const fileLabels: Array<{ test: string; via: string }> = [];
  for (const t of tests) {
    for (const s of t.strings) {
      const n = norm(s);
      if (!n) continue;
      const list = byName.get(n) ?? [];
      list.push({ test: t.id, via: s });
      byName.set(n, list);
      if (FILE_NAME_LIKE.test(s.trim())) fileLabels.push({ test: t.id, via: s.trim() });
    }
  }
  const out = new Map<string, TriggerCoverage[]>();
  for (const t of triggers) {
    const hits = new Map<string, string>();
    for (const n of triggerNames(t)) for (const h of byName.get(n) ?? []) if (!hits.has(h.test)) hits.set(h.test, h.via);
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

export interface ScanOutput {
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
  const endpoints = new Map<string, string>();
  const raw: RawRoute[] = [];
  for (const f of input.xml) {
    const r = scanCamelXml(f.path, f.text);
    raw.push(...r.routes);
    for (const [id, uri] of r.endpoints) endpoints.set(id, uri);
  }

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
  for (const r of raw) {
    const module = moduleOf(r.file);
    if (r.routeId) {
      const id = `${module ?? ''}\0${r.routeId}`;
      const first = routeIds.get(id);
      if (first) warnings.push(`route id "${r.routeId}" is defined more than once${module ? ` in ${module}` : ''} (${r.file}:${r.line}, first at ${first})`);
      else routeIds.set(id, `${r.file}:${r.line}`);
    }
    if (r.inputs.length === 0) continue;
    const conditions = r.conditions
      .map((c) => ({ c, resolved: resolvePlaceholders(normalizeCondition(c.expr), props, r.file) }))
      .map((x) => ({ ...x, parsed: parseFileCondition(x.resolved.firstVariant) }))
      .filter((x): x is { c: RawCondition; resolved: Resolved; parsed: FileCondition } => x.parsed !== null);
    let routeHasTrigger = false;
    r.inputs.forEach((inp, idx) => {
      const uri = inp.uri ?? (inp.ref ? endpoints.get(inp.ref) : undefined);
      if (!uri) {
        warnings.push(`${r.file}:${inp.line}: <from> without a uri${inp.ref ? ` (endpoint "${inp.ref}" not found)` : ''}`);
        return;
      }
      const resolved = resolvePlaceholders(uri, props, r.file);
      const ep = parseEndpoint(resolved.firstVariant);
      const kind = ep && FILE_SCHEMES.has(ep.scheme) ? 'file' : ep && SCHEDULE_SCHEMES.has(ep.scheme) ? 'schedule' : null;
      if (!ep || !kind) return;
      routeHasTrigger = true;
      // fields shown to people come from the single-valued resolution, so per-environment values stay visible as placeholders
      const shown = parseEndpoint(resolved.text) ?? ep;
      const p = shown.params;
      const id = r.routeId ?? `${r.file}#${uri}`;
      const baseKey = `${module && r.routeId ? `${module}/` : ''}${id}${r.inputs.length > 1 ? `#${idx + 1}` : ''}`;
      const base: StoredTrigger = {
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
        doneFile: kind === 'file' ? (p.doneFileName ?? null) : null,
        input: idx + 1,
        schedule: kind === 'schedule' ? describeSchedule(ep.scheme, p) : null,
        sourceFile: r.file,
        line: inp.line,
        unresolved: resolved.unresolved,
        coveredBy: [],
        match: { pattern: null, condition: null, doneFile: kind === 'file' ? (ep.params.doneFileName ?? null) : null },
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
    if (!routeHasTrigger) otherRoutes++;
  }

  const tests: TestLabels[] = input.tests.flatMap((f) => scanPytestFile(f.path, f.text)).map((t) => ({ id: t.id, strings: t.strings }));
  const coverage = coverTriggers(triggers, tests);
  for (const t of triggers) t.coveredBy = coverage.get(t.key) ?? [];
  return { triggers, tests, testsFound: tests.length, otherRoutes, warnings };
}
