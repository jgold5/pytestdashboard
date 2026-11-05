import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  LIMITS,
  SafeUrl,
  type AutomationStatus,
  type HistoryImportFields,
  type HistoryImportMode,
  type HistoryImportResponse,
  type ResultStatus,
  type Run,
  type RunImportFields,
  type RunImportResponse,
} from '@ptd/shared';
import type { Db } from '../../db/client.js';
import { runs, testCases, testResults, type TestCaseRow } from '../../db/schema.js';
import { refreshCaseStats } from '../../domain/caseStats.js';
import { recordCoverageSnapshot } from '../../domain/coverage.js';
import { linkInsertedRun } from '../../domain/history.js';
import { getRunRow, serializeRun } from '../../domain/runs.js';
import { failureSignature } from '../../domain/signature.js';
import { AppError } from '../../errors.js';
import { msToIso } from '../../util/time.js';
import type { AllureBundle, ParsedResult } from './parse.js';
import { deriveRunGroup } from './runGroup.js';
import { detectRuns } from './sessions.js';

const AS_ID_LABELS = new Set(['AS_ID', 'allure_id', 'as_id', 'ALLURE_ID']);
const JIRA_LABELS = new Set(['jira', 'xray', 'JIRA', 'XRAY']);

export interface DedupedResult extends ParsedResult {
  retries: number;
  /** Status of every attempt, oldest first, when retried; null when the test ran once. */
  attempts: ResultStatus[] | null;
}

/**
 * Same historyId within one run ⇒ retries. The attempt with the latest stop is the
 * result (ties: the later file); retries = count − 1; attempts keeps every status
 * in order, so a fail-then-pass retry still counts towards flakiness.
 */
export function dedupeRetries(results: readonly ParsedResult[]): DedupedResult[] {
  const groups = new Map<string, ParsedResult[]>();
  results.forEach((r, i) => {
    const k = r.historyId ?? r.uuid ?? `#${i}`;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  });
  const out: DedupedResult[] = [];
  for (const list of groups.values()) {
    const ordered = list
      .map((r, i) => ({ r, i, t: r.stop ?? r.start ?? 0 }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((x) => x.r);
    const best = ordered[ordered.length - 1] as ParsedResult;
    out.push({ ...best, retries: list.length - 1, attempts: list.length > 1 ? ordered.map((r) => r.status) : null });
  }
  return out;
}

/** Candidate ids for linking rule 1 (allureId / jiraKey). Order = precedence. */
export function linkCandidates(r: ParsedResult): string[] {
  const c: string[] = [];
  if (r.testCaseId) c.push(r.testCaseId);
  for (const l of r.labels) if (AS_ID_LABELS.has(l.name) && l.value) c.push(l.value);
  for (const l of r.links) if (l.type?.toLowerCase() === 'tms' && l.name) c.push(l.name);
  for (const l of r.labels) if (JIRA_LABELS.has(l.name) && l.value) c.push(l.value);
  return c;
}

/**
 * Suite for an auto-created case: explicit `feature` label as-is; otherwise the
 * allure-pytest `suite`/`parentSuite` labels or the module part of fullName —
 * which are module paths (`test_orders`, `tests.api.test_orders`), so they are
 * humanised (`Orders`) instead of showing up as code identifiers.
 */
export function suiteFromResult(r: ParsedResult): string | null {
  const feature = r.labels.find((l) => l.name === 'feature')?.value?.trim();
  if (feature) return feature.slice(0, LIMITS.shortTextMax);
  for (const name of ['suite', 'parentSuite']) {
    const v = r.labels.find((l) => l.name === name)?.value?.trim();
    if (v) return humanizeModule(v).slice(0, LIMITS.shortTextMax);
  }
  if (r.fullName) {
    const cut = r.fullName.search(/#|::/);
    const mod = cut >= 0 ? r.fullName.slice(0, cut) : r.fullName;
    const segs = mod.split(/[./]/).filter(Boolean);
    while (segs.length > 1 && /^[A-Z]/.test(segs[segs.length - 1] ?? '')) segs.pop();
    const out = segs.join('.');
    return out ? humanizeModule(out).slice(0, LIMITS.shortTextMax) : null;
  }
  return null;
}

/**
 * `tests.api.test_orders` / `tests/api/test_orders.py` / `test_orders` → `Orders`;
 * `order_flow_test` → `Order flow`. Values that don't look like a module path
 * (contain spaces, capitals, etc.) are returned unchanged.
 */
export function humanizeModule(v: string): string {
  const s = v.trim().slice(0, 500);
  if (!/^[a-z0-9_./\\-]+$/.test(s)) return s;
  const segs = s.replace(/\.py$/, '').split(/[./\\]/).filter(Boolean);
  // prefer the last segment that is a test module; else the last segment
  const last = [...segs].reverse().find((x) => /^test_|_test$/.test(x)) ?? segs[segs.length - 1] ?? s;
  const words = last.replace(/^tests?_/, '').replace(/_tests?$/, '').replace(/[_-]+/g, ' ').trim();
  if (!words) return s;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type CaseLite = Pick<TestCaseRow, 'id' | 'key' | 'allureId' | 'allureFullName' | 'jiraKey' | 'automationStatus'>;

class CaseIndex {
  byAllureId = new Map<string, CaseLite>();
  byJiraKey = new Map<string, CaseLite>();
  byFullName = new Map<string, CaseLite>();
  byKey = new Map<string, CaseLite>();

  add(c: CaseLite): void {
    if (c.allureId && !this.byAllureId.has(c.allureId)) this.byAllureId.set(c.allureId, c);
    if (c.jiraKey) this.byJiraKey.set(c.jiraKey, c);
    if (c.allureFullName && !this.byFullName.has(c.allureFullName)) this.byFullName.set(c.allureFullName, c);
    this.byKey.set(c.key, c);
  }

  /** Linking rules 1–3; undefined ⇒ rule 4 (auto-create). */
  match(r: ParsedResult): CaseLite | undefined {
    for (const cand of linkCandidates(r)) {
      const hit = this.byAllureId.get(cand) ?? this.byJiraKey.get(cand);
      if (hit) return hit;
    }
    if (r.fullName) {
      const hit = this.byFullName.get(r.fullName) ?? this.byKey.get(r.fullName);
      if (hit) return hit;
    }
    return this.byKey.get(autoKey(r));
  }
}

const autoKey = (r: ParsedResult): string => (r.fullName ?? r.name).slice(0, LIMITS.keyMax);

interface RunMeta {
  name: string;
  runGroup: string;
  branch: string | null;
  commit: string | null;
  buildUrl: string | null;
  environment: Record<string, string>;
}

const caseCols = {
  id: testCases.id,
  key: testCases.key,
  allureId: testCases.allureId,
  allureFullName: testCases.allureFullName,
  jiraKey: testCases.jiraKey,
  automationStatus: testCases.automationStatus,
};

/** Writes runs and their results inside one transaction, linking results to cases (creating them as needed). */
class RunWriter {
  private readonly index = new CaseIndex();
  created = 0;
  readonly promoted = new Set<number>();
  readonly caseIds = new Set<number>();

  constructor(
    private readonly tx: Db,
    private readonly importedAt: string,
  ) {
    for (const c of tx.select(caseCols).from(testCases).all()) this.index.add(c);
  }

  /** Insert one run; returns its id. Call `finish()` once after the last run. */
  insert(results: readonly DedupedResult[], meta: RunMeta): number {
    const { tx, importedAt } = this;
    const linked: Array<{ r: DedupedResult; caseId: number }> = [];
    const toPromote: number[] = [];
    for (const r of results) {
      let tc = this.index.match(r);
      if (!tc) {
        const tags = [...new Set(r.labels.filter((l) => l.name === 'tag' && l.value).map((l) => l.value.slice(0, 200)))].slice(
          0,
          LIMITS.tagsMax,
        );
        const row = tx
          .insert(testCases)
          .values({
            key: autoKey(r),
            title: r.name.slice(0, LIMITS.titleMax),
            suite: suiteFromResult(r),
            automationStatus: 'automated',
            tags,
            allureFullName: r.fullName,
            source: 'allure',
            automatedAt: importedAt,
            automatedVia: 'allure',
            createdAt: importedAt,
            updatedAt: importedAt,
          })
          .returning(caseCols)
          .get();
        this.index.add(row);
        tc = row;
        this.created++;
      } else if (tc.automationStatus === 'not_automated' || tc.automationStatus === 'in_progress') {
        toPromote.push(tc.id);
        this.promoted.add(tc.id);
        tc.automationStatus = 'automated' satisfies AutomationStatus;
      }
      linked.push({ r, caseId: tc.id });
      this.caseIds.add(tc.id);
    }

    for (let i = 0; i < toPromote.length; i += 500) {
      tx.update(testCases)
        .set({ automationStatus: 'automated', automatedAt: importedAt, automatedVia: 'allure', updatedAt: importedAt })
        .where(inArray(testCases.id, toPromote.slice(i, i + 500)))
        .run();
    }

    const { startedAt, stoppedAt, durationMs } = timing(results);
    const counts = statusCounts(results);
    const run = tx
      .insert(runs)
      .values({
        ...meta,
        startedAt,
        stoppedAt,
        durationMs,
        importedAt,
        sortAt: startedAt ?? importedAt,
        ...counts,
        total: linked.length,
      })
      .returning({ id: runs.id })
      .get();

    const rows = linked.map(({ r, caseId }) => {
      const failing = r.status === 'failed' || r.status === 'broken';
      return {
        runId: run.id,
        testCaseId: caseId,
        name: r.name,
        fullName: r.fullName,
        historyId: r.historyId,
        status: r.status,
        durationMs: r.start !== null && r.stop !== null && r.stop >= r.start ? r.stop - r.start : null,
        startedAt: msToIso(r.start),
        message: r.message,
        trace: r.trace,
        failureSignature: failing ? failureSignature(r.message) : null,
        retries: r.retries,
        attempts: r.attempts,
        parameters: r.parameters,
        labels: r.labels,
      };
    });
    for (let i = 0; i < rows.length; i += 200) tx.insert(testResults).values(rows.slice(i, i + 200)).run();

    linkInsertedRun(tx, run.id);
    return run.id;
  }

  finish(): void {
    refreshCaseStats(this.tx, this.caseIds);
    recordCoverageSnapshot(this.tx);
  }
}

function timing(results: readonly ParsedResult[]) {
  let minStart: number | null = null;
  let maxStop: number | null = null;
  for (const r of results) {
    if (r.start !== null) minStart = minStart === null ? r.start : Math.min(minStart, r.start);
    if (r.stop !== null) maxStop = maxStop === null ? r.stop : Math.max(maxStop, r.stop);
  }
  return {
    startedAt: msToIso(minStart),
    stoppedAt: msToIso(maxStop),
    durationMs: minStart !== null && maxStop !== null && maxStop >= minStart ? maxStop - minStart : null,
  };
}

function statusCounts(results: readonly ParsedResult[]) {
  const counts = { passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

/** Readable default run name (not a raw ISO string with millis): "Import 2026-11-04 15:23 UTC". */
const importName = (iso: string): string => `Import ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function importAllureRun(
  db: Db,
  bundle: AllureBundle,
  fields: RunImportFields,
  now: Date = new Date(),
): RunImportResponse {
  if (bundle.results.length === 0) {
    throw new AppError(400, 'no_results', 'No Allure *-result.json files found in the upload', {
      warnings: bundle.warnings,
    });
  }
  const results = dedupeRetries(bundle.results);
  const importedAt = now.toISOString();

  let runGroup = fields.runGroup;
  if (!runGroup) {
    runGroup = deriveRunGroup(results);
    bundle.warn(`Run group auto-detected as ${runGroup} — set runGroup to override`);
  }
  const meta: RunMeta = {
    name: fields.name ?? bundle.executor?.buildName ?? importName(importedAt),
    runGroup,
    branch: fields.branch ?? null,
    commit: fields.commit ?? null,
    buildUrl: fields.buildUrl !== undefined ? fields.buildUrl : safeUrl(bundle.executor?.buildUrl, bundle, 'executor.json buildUrl'),
    environment: bundle.environment,
  };

  return db.transaction((tx) => {
    const writer = new RunWriter(tx, importedAt);
    const runId = writer.insert(results, meta);
    writer.finish();
    return {
      run: serializeRun(getRunRow(tx, runId)),
      createdTestCases: writer.created,
      promotedTestCases: writer.promoted.size,
      skippedFiles: bundle.skippedFiles,
      warnings: bundle.warnings,
    };
  });
}

function safeUrl(url: string | null | undefined, bundle: AllureBundle, what: string): string | null {
  if (!url) return null;
  const ok = SafeUrl.safeParse(url);
  if (!ok.success) {
    bundle.warn(`${what} is not an http(s) URL — ignored`);
    return null;
  }
  return ok.data;
}

// ---------------------------------------------------------------------------
// History import: many runs in one upload (allure-history / allureparser layout)
// ---------------------------------------------------------------------------

/** Max results in one history import (snapshots are small; the stored-bytes cap still applies). */
export const MAX_RESULTS_PER_HISTORY_IMPORT = 250_000;

interface PlannedRun {
  results: ParsedResult[];
  name: string;
  buildUrl: string | null;
  environment: Record<string, string>;
  start: number | null;
}

/** `ci/build-12/allure-results` → `build-12`. */
function folderLabel(dir: string): string | null {
  const segs = dir.split('/').filter(Boolean);
  while (segs.length > 1 && /^allure[-_]results$/i.test(segs[segs.length - 1] ?? '')) segs.pop();
  return segs.length ? (segs[segs.length - 1] as string).slice(0, LIMITS.shortTextMax) : null;
}

function minStart(results: readonly ParsedResult[]): number | null {
  let m: number | null = null;
  for (const r of results) if (r.start !== null) m = m === null ? r.start : Math.min(m, r.start);
  return m;
}

const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * How allure-history reads an upload: several folders/snapshots ⇒ one run each;
 * a single folder ⇒ runs recovered from the pytest host + process id.
 */
export function planHistoryRuns(bundle: AllureBundle, importedAt: string): { mode: HistoryImportMode; runs: PlannedRun[] } {
  const byDir = new Map<string, ParsedResult[]>();
  for (const r of bundle.results) {
    const dir = r.source ?? '';
    const list = byDir.get(dir) ?? [];
    list.push(r);
    byDir.set(dir, list);
  }
  const fromSnapshots: PlannedRun[] = bundle.snapshots.map((s) => ({
    results: s.results,
    name: s.label,
    buildUrl: safeUrl(s.url, bundle, `${s.file}: url`),
    environment: {},
    start: s.start ?? minStart(s.results),
  }));

  if (byDir.size === 1 && fromSnapshots.length === 0) {
    const [dir, results] = [...byDir][0] as [string, ParsedResult[]];
    const executor = bundle.executors.get(dir);
    const detected = detectRuns(results);
    const runs = detected.map((d) => ({
      results: d.results,
      name:
        detected.length === 1 && executor?.buildName
          ? executor.buildName
          : d.start !== null
            ? `Run ${utc(d.start)} UTC${d.host ? ` · ${d.host}` : ''}`.slice(0, LIMITS.shortTextMax)
            : (folderLabel(dir) ?? importName(importedAt)),
      buildUrl: detected.length === 1 ? safeUrl(executor?.buildUrl, bundle, 'executor.json buildUrl') : null,
      environment: bundle.environments.get(dir) ?? {},
      start: d.start,
    }));
    return { mode: 'detected', runs };
  }

  const fromDirs: PlannedRun[] = [...byDir].map(([dir, results]) => {
    const executor = bundle.executors.get(dir);
    return {
      results,
      name: executor?.buildName ?? folderLabel(dir) ?? importName(importedAt),
      buildUrl: safeUrl(executor?.buildUrl, bundle, `${dir || 'executor.json'}: buildUrl`),
      environment: bundle.environments.get(dir) ?? {},
      start: minStart(results),
    };
  });
  return { mode: 'per_source', runs: [...fromDirs, ...fromSnapshots] };
}

/** A run with the same group, branch, timing and counts is the same run imported before. */
function isDuplicateRun(tx: Db, runGroup: string, branch: string | null, results: readonly DedupedResult[]): boolean {
  const { startedAt, stoppedAt } = timing(results);
  if (startedAt === null) return false; // no timing data: can't tell identical-looking runs apart
  const c = statusCounts(results);
  const hit = tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.runGroup, runGroup),
        branch === null ? isNull(runs.branch) : eq(runs.branch, branch),
        eq(runs.startedAt, startedAt),
        stoppedAt === null ? isNull(runs.stoppedAt) : eq(runs.stoppedAt, stoppedAt),
        eq(runs.total, results.length),
        eq(runs.passed, c.passed),
        eq(runs.failed, c.failed),
        eq(runs.broken, c.broken),
        eq(runs.skipped, c.skipped),
      ),
    )
    .limit(1)
    .get();
  return hit !== undefined;
}

export function importHistory(db: Db, bundle: AllureBundle, fields: HistoryImportFields, now: Date = new Date()): HistoryImportResponse {
  if (bundle.results.length === 0 && bundle.snapshots.length === 0) {
    throw new AppError(400, 'no_results', 'No Allure *-result.json files or allure-history snapshots found in the upload', {
      warnings: bundle.warnings,
    });
  }
  const importedAt = now.toISOString();
  const plan = planHistoryRuns(bundle, importedAt);
  plan.runs.sort((a, b) => Number(a.start === null) - Number(b.start === null) || (a.start ?? 0) - (b.start ?? 0));
  const branch = fields.branch ?? null;

  return db.transaction((tx) => {
    const writer = new RunWriter(tx, importedAt);
    const ids: number[] = [];
    const autoGroups = new Map<string, number>();
    let duplicateRuns = 0;
    for (const planned of plan.runs) {
      const results = dedupeRetries(planned.results);
      let runGroup = fields.runGroup;
      if (!runGroup) {
        runGroup = deriveRunGroup(results);
        autoGroups.set(runGroup, (autoGroups.get(runGroup) ?? 0) + 1);
      }
      if (isDuplicateRun(tx, runGroup, branch, results)) {
        duplicateRuns++;
        continue;
      }
      ids.push(
        writer.insert(results, {
          name: planned.name,
          runGroup,
          branch,
          commit: null,
          buildUrl: planned.buildUrl,
          environment: planned.environment,
        }),
      );
    }
    for (const [group, n] of autoGroups) {
      bundle.warn(`Run group auto-detected as ${group}${n > 1 ? ` (${n} runs)` : ''} — set runGroup to override`);
    }
    if (duplicateRuns > 0) bundle.warn(`${duplicateRuns} run${duplicateRuns === 1 ? ' was' : 's were'} already imported — skipped`);
    writer.finish();
    const out: Run[] = ids.map((id) => serializeRun(getRunRow(tx, id)));
    return {
      mode: plan.mode,
      runs: out,
      duplicateRuns,
      createdTestCases: writer.created,
      promotedTestCases: writer.promoted.size,
      skippedFiles: bundle.skippedFiles,
      warnings: bundle.warnings,
    };
  });
}
