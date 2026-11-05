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

/** Fill in placeholders (values may reference other keys; ≤ 5 rounds). */
export function resolvePlaceholders(input: string, props: PropertyIndex): Resolved {
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
        const values = props.get(key);
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

export interface RawRoute {
  routeId: string | null;
  uri: string | null;
  ref: string | null;
  file: string;
  line: number;
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

/** Routes (`<route>` … `<from>`) and named endpoints (`<endpoint id uri>`) in one XML file. */
export function scanCamelXml(file: string, xml: string): { routes: RawRoute[]; endpoints: Map<string, string> } {
  const text = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/g, blank);
  const routes: RawRoute[] = [];
  const endpoints = new Map<string, string>();
  const stack: Array<{ id: string | null; from: boolean }> = [];
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
    if (name === 'route') {
      if (closing) stack.pop();
      else if (!selfClosing) {
        const a = attrs(m[3] ?? '');
        stack.push({ id: a.id ?? a.routeId ?? null, from: false });
      }
      continue;
    }
    if (closing) continue;
    if (name === 'endpoint') {
      const a = attrs(m[3] ?? '');
      if (a.id && a.uri) endpoints.set(a.id, a.uri);
      continue;
    }
    if (name === 'from') {
      const route = stack[stack.length - 1];
      if (!route) continue; // a <from> outside a <route> is not a route input
      const a = attrs(m[3] ?? '');
      // only the first <from> starts the route in Camel 3+; older XML allowed several inputs, keep them all
      routes.push({ routeId: route.id, uri: a.uri ?? null, ref: a.ref ?? null, file, line: lineOf(m.index ?? 0) });
      route.from = true;
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
  /** Candidate strings: decorator string arguments, marker names, allure.dynamic.* arguments. */
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
    const v = lit.slice(q, -q).replace(/\\(.)/g, '$1').trim();
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
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);
    if (cls && indent <= cls.indent && !trimmed.startsWith('@')) cls = null;
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
      const dynamic: string[] = [];
      const bodyText = body.join('\n');
      for (const m of bodyText.matchAll(/allure\.dynamic\.\w+\s*\(/g)) {
        let k = (m.index ?? 0) + m[0].length;
        let depth = 1;
        for (; k < bodyText.length && depth > 0; k++) {
          if (bodyText[k] === '(') depth++;
          else if (bodyText[k] === ')') depth--;
        }
        dynamic.push(...strings(bodyText.slice((m.index ?? 0) + m[0].length, k - 1)));
      }
      const name = d[1] as string;
      tests.push({
        id: inClass && cls ? `${file}::${cls.name}::${name}` : `${file}::${name}`,
        file,
        cls: inClass && cls ? cls.name : null,
        name,
        strings: [...new Set([...pending, ...(inClass && cls ? cls.strings : []), ...dynamic])],
      });
      pending = [];
      i = j - 1;
      continue;
    }
    pending = [];
  }
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

/** Can `candidate` (a label value) name this trigger? Returns why, or null. */
function matches(t: Trigger, candidate: string, filePatternRe: RegExp | null): boolean {
  const c = norm(candidate);
  if (!c) return false;
  if (t.routeId && norm(t.routeId) === c) return true;
  if (t.kind === 'schedule') {
    const p = parseEndpoint(t.resolvedUri);
    const name = p?.path.split('/').filter(Boolean).pop();
    if (name && norm(name) === c) return true;
  }
  if (t.kind === 'file' && t.filePattern) {
    if (norm(t.filePattern) === c) return true;
    // a label that is a file name the route would pick up, e.g. INV_20260101.csv
    if (/^[\w.-]+\.\w+$/.test(candidate.trim()) && filePatternRe?.test(candidate.trim())) return true;
  }
  return false;
}

export interface ScanInput {
  xml: ReadonlyArray<{ path: string; text: string }>;
  properties: ReadonlyArray<{ path: string; text: string }>;
  tests: ReadonlyArray<{ path: string; text: string }>;
}

export interface ScanOutput {
  triggers: Trigger[];
  testsFound: number;
  otherRoutes: number;
  warnings: string[];
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

  const triggers: Trigger[] = [];
  const seenKeys = new Map<string, number>();
  let otherRoutes = 0;
  for (const r of raw) {
    const uri = r.uri ?? (r.ref ? endpoints.get(r.ref) : undefined);
    if (!uri) {
      warnings.push(`${r.file}:${r.line}: <from> without a uri${r.ref ? ` (endpoint "${r.ref}" not found)` : ''}`);
      continue;
    }
    const resolved = resolvePlaceholders(uri, props);
    const ep = parseEndpoint(resolved.firstVariant);
    const kind = ep && FILE_SCHEMES.has(ep.scheme) ? 'file' : ep && SCHEDULE_SCHEMES.has(ep.scheme) ? 'schedule' : null;
    if (!ep || !kind) {
      otherRoutes++;
      continue;
    }
    // fields shown to people come from the single-valued resolution, so per-environment values stay visible as placeholders
    const shown = parseEndpoint(resolved.text) ?? ep;
    const p = shown.params;
    const schedule =
      kind === 'schedule'
        ? (p.cron ?? p.schedule ?? (p.period ? `every ${p.period} ms` : null) ?? (p.delay ? `every ${p.delay} ms` : null) ?? (p['trigger.repeatInterval'] ? `every ${p['trigger.repeatInterval']} ms` : null))
        : null;
    let key = r.routeId ?? `${r.file}#${uri}`;
    const n = (seenKeys.get(key) ?? 0) + 1;
    seenKeys.set(key, n);
    if (n > 1) {
      if (r.routeId) warnings.push(`route id "${r.routeId}" is defined more than once (${r.file}:${r.line})`);
      key = `${key}#${n}`;
    }
    triggers.push({
      key,
      routeId: r.routeId,
      kind,
      scheme: ep.scheme,
      uri,
      resolvedUri: resolved.text,
      directory: kind === 'file' ? shown.path || null : null,
      filePattern: kind === 'file' ? (p.include ?? p.antInclude ?? p.fileName ?? null) : null,
      schedule,
      sourceFile: r.file,
      line: r.line,
      unresolved: resolved.unresolved,
      coveredBy: [],
    });
  }

  const tests = input.tests.flatMap((f) => scanPytestFile(f.path, f.text));
  for (const t of triggers) {
    const pattern = t.kind === 'file' ? (parseEndpoint(resolvePlaceholders(t.uri, props).firstVariant)?.params ?? {}) : {};
    const re = pattern.include ? safeRegex(pattern.include) : pattern.antInclude ? antRegex(pattern.antInclude) : null;
    const covered: TriggerCoverage[] = [];
    for (const test of tests) {
      const via = test.strings.find((s) => matches(t, s, re));
      if (via) covered.push({ test: test.id, via, testCaseId: null });
    }
    t.coveredBy = covered;
  }
  return { triggers, testsFound: tests.length, otherRoutes, warnings };
}
