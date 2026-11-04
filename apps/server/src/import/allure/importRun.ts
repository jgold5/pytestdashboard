import { inArray } from 'drizzle-orm';
import { LIMITS, SafeUrl, type AutomationStatus, type RunImportFields, type RunImportResponse } from '@ptd/shared';
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

const AS_ID_LABELS = new Set(['AS_ID', 'allure_id', 'as_id', 'ALLURE_ID']);
const JIRA_LABELS = new Set(['jira', 'xray', 'JIRA', 'XRAY']);

export interface DedupedResult extends ParsedResult {
  retries: number;
}

/** Same historyId within one upload ⇒ keep the one with the latest stop; retries = count − 1. */
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
    let best = list[0] as ParsedResult;
    for (const r of list) {
      const a = r.stop ?? r.start ?? 0;
      const b = best.stop ?? best.start ?? 0;
      if (a >= b) best = r;
    }
    out.push({ ...best, retries: list.length - 1 });
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

export function suiteFromResult(r: ParsedResult): string | null {
  for (const name of ['feature', 'suite', 'parentSuite']) {
    const v = r.labels.find((l) => l.name === name)?.value;
    if (v) return v.slice(0, LIMITS.shortTextMax);
  }
  if (r.fullName) {
    const cut = r.fullName.search(/#|::/);
    const mod = cut >= 0 ? r.fullName.slice(0, cut) : r.fullName;
    const segs = mod.split(/[./]/).filter(Boolean);
    while (segs.length > 1 && /^[A-Z]/.test(segs[segs.length - 1] ?? '')) segs.pop();
    const out = segs.join('.');
    return out ? out.slice(0, LIMITS.shortTextMax) : null;
  }
  return null;
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

function resolveBuildUrl(fields: RunImportFields, bundle: AllureBundle): string | null {
  if (fields.buildUrl !== undefined) return fields.buildUrl;
  const fromExecutor = bundle.executor?.buildUrl;
  if (!fromExecutor) return null;
  const ok = SafeUrl.safeParse(fromExecutor);
  if (!ok.success) {
    bundle.warn('executor.json buildUrl is not an http(s) URL — ignored');
    return null;
  }
  return ok.data;
}

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

  const starts = results.map((r) => r.start).filter((v): v is number => v !== null);
  const stops = results.map((r) => r.stop).filter((v): v is number => v !== null);
  const minStart = starts.length ? Math.min(...starts) : null;
  const maxStop = stops.length ? Math.max(...stops) : null;
  const startedAt = msToIso(minStart);
  const stoppedAt = msToIso(maxStop);
  const name = fields.name ?? bundle.executor?.buildName ?? `Import ${importedAt}`;
  const buildUrl = resolveBuildUrl(fields, bundle);

  return db.transaction((tx) => {
    const index = new CaseIndex();
    for (const c of tx
      .select({
        id: testCases.id,
        key: testCases.key,
        allureId: testCases.allureId,
        allureFullName: testCases.allureFullName,
        jiraKey: testCases.jiraKey,
        automationStatus: testCases.automationStatus,
      })
      .from(testCases)
      .all()) {
      index.add(c);
    }

    let created = 0;
    const toPromote = new Set<number>();
    const linked: Array<{ r: DedupedResult; caseId: number }> = [];
    for (const r of results) {
      let tc = index.match(r);
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
            createdAt: importedAt,
            updatedAt: importedAt,
          })
          .returning({
            id: testCases.id,
            key: testCases.key,
            allureId: testCases.allureId,
            allureFullName: testCases.allureFullName,
            jiraKey: testCases.jiraKey,
            automationStatus: testCases.automationStatus,
          })
          .get();
        index.add(row);
        tc = row;
        created++;
      } else if (tc.automationStatus === 'not_automated' || tc.automationStatus === 'in_progress') {
        toPromote.add(tc.id);
        tc.automationStatus = 'automated' satisfies AutomationStatus;
      }
      linked.push({ r, caseId: tc.id });
    }

    if (toPromote.size > 0) {
      const ids = [...toPromote];
      for (let i = 0; i < ids.length; i += 500) {
        tx.update(testCases)
          .set({ automationStatus: 'automated', automatedAt: importedAt, updatedAt: importedAt })
          .where(inArray(testCases.id, ids.slice(i, i + 500)))
          .run();
      }
    }

    const counts = { passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
    for (const { r } of linked) counts[r.status]++;
    const run = tx
      .insert(runs)
      .values({
        name,
        runGroup,
        branch: fields.branch ?? null,
        commit: fields.commit ?? null,
        buildUrl,
        environment: bundle.environment,
        startedAt,
        stoppedAt,
        durationMs: minStart !== null && maxStop !== null && maxStop >= minStart ? maxStop - minStart : null,
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
        parameters: r.parameters,
        labels: r.labels,
      };
    });
    for (let i = 0; i < rows.length; i += 200) tx.insert(testResults).values(rows.slice(i, i + 200)).run();

    linkInsertedRun(tx, run.id);
    refreshCaseStats(
      tx,
      linked.map((l) => l.caseId),
    );
    recordCoverageSnapshot(tx);

    return {
      run: serializeRun(getRunRow(tx, run.id)),
      createdTestCases: created,
      promotedTestCases: toPromote.size,
      skippedFiles: bundle.skippedFiles,
      warnings: bundle.warnings,
    };
  });
}

