/**
 * Collects files of an allure-results directory (from a zip or a multipart
 * folder upload) into a parsed bundle. Never throws on bad content: problems
 * become warnings.
 */
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { LIMITS, type ResultStatus } from '@ptd/shared';
import type { NameValue } from '../../db/schema.js';
import { AppError } from '../../errors.js';

/** Per-file cap for result JSON / executor.json. */
export const MAX_JSON_BYTES = 5 * 1024 * 1024;
/** Per-result caps on what is stored (amplification control). */
const MAX_LABELS = 50;
const MAX_VALUE = 500;
const MAX_NAME_VALUES_BYTES = 16 * 1024;
const MAX_TRACE = 16 * 1024;
/** Per-import caps. */
export const MAX_RESULTS_PER_IMPORT = 50_000;
export const MAX_STORED_BYTES_PER_IMPORT = 256 * 1024 * 1024;
const MAX_WARNINGS = 100;

const RESULT_RE = /-result\.json$/i;
/** allure-history (allureparser) snapshot: gzipped JSON of one run's results. */
export const SNAPSHOT_RE = /\.snapshot\.json\.gz$/i;
/** Decompressed size cap for one snapshot (a 3,000-test run is ~1 MB). */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_FORMAT = 'allure-history-snapshot';
const SNAPSHOT_MAX_VERSION = 2;
const CONTAINER_RE = /-container\.json$/i;
const IGNORED_KNOWN = new Set(['categories.json']);

/** Basenames we accept in an upload (everything else is ignored without reading). */
export function isAllowedAllureFile(basename: string, opts: { snapshots?: boolean } = {}): boolean {
  return (
    RESULT_RE.test(basename) ||
    (opts.snapshots === true && SNAPSHOT_RE.test(basename)) ||
    CONTAINER_RE.test(basename) ||
    basename === 'environment.properties' ||
    basename === 'executor.json' ||
    IGNORED_KNOWN.has(basename)
  );
}

export interface ParsedResult {
  file: string;
  uuid: string | null;
  historyId: string | null;
  testCaseId: string | null;
  fullName: string | null;
  name: string;
  status: ResultStatus;
  message: string | null;
  trace: string | null;
  start: number | null;
  stop: number | null;
  labels: NameValue[];
  parameters: NameValue[];
  links: Array<{ name: string | null; url: string | null; type: string | null }>;
  /** Folder of the file inside the upload ('' = top level); used to split multi-run uploads. */
  source?: string;
  /** 'host:pid' of the pytest process that produced the result, when recorded. */
  session?: string | null;
}

/** One allure-history snapshot = one run. */
export interface SnapshotRun {
  file: string;
  label: string;
  order: number | null;
  url: string | null;
  start: number | null;
  results: ParsedResult[];
}

export interface BundleOptions {
  /** Accept allure-history `*.snapshot.json.gz` files. */
  snapshots?: boolean;
  maxResults?: number;
}

export interface Executor {
  name: string | null;
  buildName: string | null;
  buildUrl: string | null;
}

export class AllureBundle {
  readonly results: ParsedResult[] = [];
  readonly snapshots: SnapshotRun[] = [];
  environment: Record<string, string> = {};
  executor: Executor | null = null;
  /** executor.json / environment.properties per folder of the upload. */
  readonly executors = new Map<string, Executor>();
  readonly environments = new Map<string, Record<string, string>>();
  private readonly acceptSnapshots: boolean;
  private readonly maxResults: number;
  private resultCount = 0;
  skippedFiles = 0;
  private readonly warningList: string[] = [];
  private droppedWarnings = 0;
  /** Estimated bytes that would be stored for the parsed results. */
  storedBytes = 0;

  constructor(opts: BundleOptions = {}) {
    this.acceptSnapshots = opts.snapshots === true;
    this.maxResults = opts.maxResults ?? MAX_RESULTS_PER_IMPORT;
  }

  get warnings(): string[] {
    return this.droppedWarnings > 0
      ? [...this.warningList, `…and ${this.droppedWarnings} more warnings`]
      : [...this.warningList];
  }

  warn(msg: string): void {
    if (this.warningList.length < MAX_WARNINGS) this.warningList.push(msg);
    else this.droppedWarnings++;
  }

  /** Add one file by its basename; `dir` is its folder inside the upload. */
  addFile(basename: string, data: Buffer, dir = ''): void {
    if (RESULT_RE.test(basename)) return this.addResult(basename, data, dir);
    if (this.acceptSnapshots && SNAPSHOT_RE.test(basename)) return this.addSnapshot(dir ? `${dir}/${basename}` : basename, data);
    if (basename === 'environment.properties') {
      if (data.length > MAX_PROPERTIES_BYTES) {
        this.warn('environment.properties: file too large, ignored');
        return;
      }
      const props = parseProperties(data.toString('utf8'));
      this.environment = { ...this.environment, ...props };
      this.environments.set(dir, { ...this.environments.get(dir), ...props });
      return;
    }
    if (basename === 'executor.json') return this.addExecutor(data, dir);
    // containers, categories, attachments: accepted but not used in v1
    this.skippedFiles++;
  }

  private parseJson(basename: string, data: Buffer): unknown {
    if (data.length > MAX_JSON_BYTES) {
      this.warn(`${basename}: file too large, skipped`);
      return undefined;
    }
    try {
      return JSON.parse(data.toString('utf8')) as unknown;
    } catch {
      this.warn(`${basename}: invalid JSON, skipped`);
      return undefined;
    }
  }

  private addExecutor(data: Buffer, dir: string): void {
    const json = this.parseJson('executor.json', data);
    if (json === undefined) return;
    const parsed = RawExecutor.safeParse(json);
    if (!parsed.success) {
      this.warn('executor.json: unexpected format, ignored');
      return;
    }
    this.executor = {
      name: str(parsed.data.name, LIMITS.shortTextMax),
      buildName: str(parsed.data.buildName, LIMITS.shortTextMax),
      buildUrl: str(parsed.data.buildUrl, LIMITS.urlMax),
    };
    this.executors.set(dir, this.executor);
  }

  /** Count a result against the per-import caps (throws 413 when exceeded). */
  private admit(r: ParsedResult): void {
    if (++this.resultCount > this.maxResults) {
      throw new AppError(413, 'too_many_results', `An import may contain at most ${this.maxResults} results`);
    }
    this.storedBytes += estimateBytes(r);
    if (this.storedBytes > MAX_STORED_BYTES_PER_IMPORT) {
      throw new AppError(413, 'import_too_large', 'This import would store too much data — split it into smaller uploads');
    }
  }

  private addSnapshot(file: string, data: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(gunzipSync(data, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString('utf8')) as unknown;
    } catch {
      this.warn(`${file}: not a readable snapshot (bad gzip/JSON or too large), skipped`);
      this.skippedFiles++;
      return;
    }
    const parsed = RawSnapshot.safeParse(json);
    if (!parsed.success || parsed.data.format !== SNAPSHOT_FORMAT) {
      this.warn(`${file}: not an allure-history snapshot, skipped`);
      this.skippedFiles++;
      return;
    }
    const version = parsed.data.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version > SNAPSHOT_MAX_VERSION) {
      this.warn(`${file}: unsupported snapshot version ${String(version)}, skipped`);
      this.skippedFiles++;
      return;
    }
    const base = file.slice(file.lastIndexOf('/') + 1).replace(SNAPSHOT_RE, '');
    const snap: SnapshotRun = {
      file,
      label: str(parsed.data.label, LIMITS.shortTextMax) ?? base.slice(0, LIMITS.shortTextMax),
      order: buildOrder(parsed.data.order),
      url: str(parsed.data.url, LIMITS.urlMax),
      start: num(parsed.data.start),
      results: [],
    };
    for (const entry of Array.isArray(parsed.data.tests) ? parsed.data.tests : []) {
      const t = RawSnapshotTest.safeParse(entry);
      if (!t.success) continue;
      const key = str(t.data.k, 200);
      const display = str(t.data.n, LIMITS.keyMax) ?? key;
      if (!key || !display || !Array.isArray(t.data.a)) continue;
      const { fullName, name } = splitDisplayName(display);
      for (const a of t.data.a) {
        if (!Array.isArray(a) || a.length === 0) continue;
        const location = str(a[4], 300);
        const r: ParsedResult = {
          file,
          uuid: null,
          historyId: key,
          testCaseId: null,
          fullName,
          name,
          status: normalizeStatus(a[0]),
          message: str(a[3], LIMITS.messageMax),
          // Snapshots keep only where the failure happened (pytest's `file.py:LINE`), not the trace.
          trace: location,
          start: num(a[1]),
          stop: num(a[2]),
          labels: [],
          parameters: [],
          links: [],
          source: file,
          session: str(a[5], 200),
        };
        this.admit(r);
        snap.results.push(r);
      }
    }
    if (snap.results.length === 0) {
      this.warn(`${file}: snapshot has no results, skipped`);
      this.skippedFiles++;
      return;
    }
    this.snapshots.push(snap);
  }

  private addResult(basename: string, data: Buffer, dir: string): void {
    const json = this.parseJson(basename, data);
    if (json === undefined) {
      this.skippedFiles++;
      return;
    }
    const parsed = RawResult.safeParse(json);
    if (!parsed.success) {
      this.warn(`${basename}: not an Allure result, skipped`);
      this.skippedFiles++;
      return;
    }
    const r = parsed.data;
    const name = str(r.name, LIMITS.titleMax) ?? str(r.fullName, LIMITS.titleMax);
    if (!name) {
      this.warn(`${basename}: result has no name/fullName, skipped`);
      this.skippedFiles++;
      return;
    }
    const parsedResult: ParsedResult = {
      file: basename,
      uuid: str(r.uuid, 200),
      historyId: str(r.historyId, 200),
      testCaseId: str(r.testCaseId, LIMITS.shortTextMax),
      fullName: str(r.fullName, LIMITS.keyMax),
      name,
      status: normalizeStatus(r.status),
      message: str(r.statusDetails?.message, LIMITS.messageMax),
      trace: str(r.statusDetails?.trace, Math.min(MAX_TRACE, LIMITS.traceMax)),
      start: num(r.start),
      stop: num(r.stop),
      labels: nameValues(r.labels),
      parameters: nameValues(r.parameters),
      links: links(r.links),
      source: dir,
    };
    parsedResult.session = sessionId(parsedResult.labels);
    this.admit(parsedResult);
    this.results.push(parsedResult);
  }
}

function estimateBytes(r: ParsedResult): number {
  let n = 256 + r.name.length + (r.fullName?.length ?? 0) + (r.message?.length ?? 0) + (r.trace?.length ?? 0);
  for (const l of [...r.labels, ...r.parameters]) n += l.name.length + l.value.length + 32;
  return n;
}

// --- permissive schemas -------------------------------------------------------

const opt = z.unknown().optional();
const RawResult = z.looseObject({
  uuid: opt,
  historyId: opt,
  testCaseId: opt,
  fullName: opt,
  name: opt,
  status: opt,
  statusDetails: z.looseObject({ message: opt, trace: opt }).nullish().catch(undefined).optional(),
  start: opt,
  stop: opt,
  labels: z.array(z.unknown()).nullish().catch(undefined).optional(),
  parameters: z.array(z.unknown()).nullish().catch(undefined).optional(),
  links: z.array(z.unknown()).nullish().catch(undefined).optional(),
});

const RawExecutor = z.looseObject({ name: opt, buildName: opt, buildUrl: opt });

/** allure-history snapshot (see allureparser's snapshot.py): tests[].a = [[status, start, stop, message, location, session], …]. */
const RawSnapshot = z.looseObject({ format: opt, version: opt, label: opt, order: opt, url: opt, start: opt, tests: opt });
const RawSnapshotTest = z.looseObject({ k: opt, n: opt, f: opt, c: opt, a: opt });

function buildOrder(v: unknown): number | null {
  const n = typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

/**
 * allure-history display names are `fullName` plus a `[param=value, …]` suffix when the
 * test is parameterized. Recover the fullName (what raw imports link cases by) and a
 * short name like Allure's (`test_create_order[currency=EUR]`).
 */
export function splitDisplayName(display: string): { fullName: string; name: string } {
  let fullName = display;
  let params = '';
  const hashAt = display.indexOf('#');
  const sep = hashAt >= 0 ? hashAt : display.indexOf('::');
  const open = display.indexOf('[', sep + 1);
  if (display.endsWith(']') && open > 0) {
    fullName = display.slice(0, open);
    params = display.slice(open);
  }
  const hash = fullName.lastIndexOf('#');
  const colons = fullName.lastIndexOf('::');
  const cut = hash >= 0 ? hash + 1 : colons >= 0 ? colons + 2 : fullName.lastIndexOf('.') + 1;
  const short = fullName.slice(cut) || fullName;
  return { fullName, name: `${short}${params}`.slice(0, LIMITS.titleMax) };
}

/**
 * 'host:pid' of the pytest process that wrote a result. allure-pytest records a
 * `host` label and a `thread` label of the form `<pid>-<thread name>`; every pytest
 * run (and every xdist worker) is its own process.
 */
export function sessionId(labels: readonly NameValue[]): string | null {
  const host = labels.find((l) => l.name === 'host')?.value ?? '';
  const pid = /^(\d+)-/.exec(labels.find((l) => l.name === 'thread')?.value ?? '')?.[1] ?? '';
  return host && pid ? `${host}:${pid}`.slice(0, 200) : null;
}

function str(v: unknown, max: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

const STATUSES = new Set<ResultStatus>(['passed', 'failed', 'broken', 'skipped', 'unknown']);
function normalizeStatus(v: unknown): ResultStatus {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return STATUSES.has(s as ResultStatus) ? (s as ResultStatus) : 'unknown';
}

function nameValues(arr: unknown[] | null | undefined): NameValue[] {
  const out: NameValue[] = [];
  let bytes = 0;
  for (const item of arr ?? []) {
    if (out.length >= MAX_LABELS || bytes >= MAX_NAME_VALUES_BYTES) break;
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = str(rec.name, LIMITS.shortTextMax);
    const value = rec.value === null || rec.value === undefined ? '' : (str(rec.value, MAX_VALUE) ?? (typeof rec.value === 'boolean' ? String(rec.value) : ''));
    if (name) {
      out.push({ name, value });
      bytes += name.length + value.length;
    }
  }
  return out;
}

function links(arr: unknown[] | null | undefined): ParsedResult['links'] {
  const out: ParsedResult['links'] = [];
  for (const item of arr ?? []) {
    if (out.length >= 50) break;
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    out.push({ name: str(rec.name, LIMITS.shortTextMax), url: str(rec.url, LIMITS.urlMax), type: str(rec.type, 50) });
  }
  return out;
}

export const MAX_PROPERTIES_BYTES = 64 * 1024;
const MAX_PROPERTIES_LINE = 8 * 1024;

/**
 * Java-style .properties (key=value / key: value, # and ! comments). Linear
 * time (indexOf-based, no regex backtracking), lines > 8 KB skipped, ≤ 200 keys.
 */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const raw of text.split('\n')) {
    if (raw.length > MAX_PROPERTIES_LINE) continue;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const sep = eq < 0 ? colon : colon < 0 ? eq : Math.min(eq, colon);
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().slice(0, LIMITS.shortTextMax);
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = line.slice(sep + 1).trim().slice(0, MAX_VALUE);
    if (++n >= 200) break;
  }
  return out;
}
