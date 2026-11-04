/**
 * Collects files of an allure-results directory (from a zip or a multipart
 * folder upload) into a parsed bundle. Never throws on bad content: problems
 * become warnings.
 */
import { z } from 'zod';
import { LIMITS, type ResultStatus } from '@ptd/shared';
import type { NameValue } from '../../db/schema.js';

export const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_LABELS = 200;
const MAX_VALUE = 1000;
const MAX_WARNINGS = 100;

const RESULT_RE = /-result\.json$/i;
const CONTAINER_RE = /-container\.json$/i;
const IGNORED_KNOWN = new Set(['categories.json']);

/** Basenames we accept in an upload (everything else is ignored without reading). */
export function isAllowedAllureFile(basename: string): boolean {
  return (
    RESULT_RE.test(basename) ||
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
}

export interface Executor {
  name: string | null;
  buildName: string | null;
  buildUrl: string | null;
}

export class AllureBundle {
  readonly results: ParsedResult[] = [];
  environment: Record<string, string> = {};
  executor: Executor | null = null;
  skippedFiles = 0;
  private readonly warningList: string[] = [];
  private droppedWarnings = 0;

  get warnings(): string[] {
    return this.droppedWarnings > 0
      ? [...this.warningList, `…and ${this.droppedWarnings} more warnings`]
      : [...this.warningList];
  }

  warn(msg: string): void {
    if (this.warningList.length < MAX_WARNINGS) this.warningList.push(msg);
    else this.droppedWarnings++;
  }

  /** Add one file by its basename. */
  addFile(basename: string, data: Buffer): void {
    if (RESULT_RE.test(basename)) return this.addResult(basename, data);
    if (basename === 'environment.properties') {
      this.environment = { ...this.environment, ...parseProperties(data.toString('utf8')) };
      return;
    }
    if (basename === 'executor.json') return this.addExecutor(data);
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

  private addExecutor(data: Buffer): void {
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
  }

  private addResult(basename: string, data: Buffer): void {
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
    this.results.push({
      file: basename,
      uuid: str(r.uuid, 200),
      historyId: str(r.historyId, 200),
      testCaseId: str(r.testCaseId, LIMITS.shortTextMax),
      fullName: str(r.fullName, LIMITS.keyMax),
      name,
      status: normalizeStatus(r.status),
      message: str(r.statusDetails?.message, LIMITS.messageMax),
      trace: str(r.statusDetails?.trace, LIMITS.traceMax),
      start: num(r.start),
      stop: num(r.stop),
      labels: nameValues(r.labels),
      parameters: nameValues(r.parameters),
      links: links(r.links),
    });
  }
}

// --- permissive schemas -------------------------------------------------------

const RawResult = z.looseObject({
  uuid: z.unknown(),
  historyId: z.unknown(),
  testCaseId: z.unknown(),
  fullName: z.unknown(),
  name: z.unknown(),
  status: z.unknown(),
  statusDetails: z.looseObject({ message: z.unknown(), trace: z.unknown() }).nullish().catch(null),
  start: z.unknown(),
  stop: z.unknown(),
  labels: z.array(z.unknown()).nullish().catch(null),
  parameters: z.array(z.unknown()).nullish().catch(null),
  links: z.array(z.unknown()).nullish().catch(null),
});

const RawExecutor = z.looseObject({ name: z.unknown(), buildName: z.unknown(), buildUrl: z.unknown() });

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
  for (const item of arr ?? []) {
    if (out.length >= MAX_LABELS) break;
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = str(rec.name, LIMITS.shortTextMax);
    const value = rec.value === null || rec.value === undefined ? '' : (str(rec.value, MAX_VALUE) ?? (typeof rec.value === 'boolean' ? String(rec.value) : ''));
    if (name) out.push({ name, value });
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

/** Java-style .properties (key=value / key: value, # and ! comments). Capped. */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const key = m[1].trim().slice(0, LIMITS.shortTextMax);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = (m[2] ?? '').trim().slice(0, MAX_VALUE);
    if (++n >= 200) break;
  }
  return out;
}
