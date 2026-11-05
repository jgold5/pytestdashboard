import { inArray } from 'drizzle-orm';
import {
  TestCaseCreate,
  type AutomationStatus,
  type ImportCommitRequest,
  type ImportCommitResponse,
  type ImportField,
  type ImportStatusValuesResponse,
} from '@ptd/shared';
import type { Db } from '../../db/client.js';
import { testCases } from '../../db/schema.js';
import { recordCoverageSnapshot } from '../../domain/coverage.js';
import { isJiraKey, normalizeAutomationStatus, normalizePriority, splitTags } from '../../domain/normalize.js';
import { badRequest } from '../../errors.js';
import { nowIso } from '../../util/time.js';
import type { ParsedSheet } from './parse.js';

const MAX_ERRORS = 100;

export function findSheet(sheets: ParsedSheet[], name: string): ParsedSheet {
  const s = sheets.find((x) => x.name === name);
  if (!s) throw badRequest(`Sheet "${name}" not found in upload`);
  return s;
}

export function statusValues(sheet: ParsedSheet, column: string): ImportStatusValuesResponse {
  const idx = sheet.headers.indexOf(column);
  if (idx < 0) throw badRequest(`Column "${column}" not found in sheet`);
  const counts = new Map<string, number>();
  for (const r of sheet.rows) {
    const v = r.cells[idx] ?? '';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return {
    values: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 500)
      .map(([raw, count]) => ({ raw, count, suggested: normalizeAutomationStatus(raw) ?? 'not_automated' })),
  };
}

class Rollback extends Error {}

interface RowInput {
  row: number;
  values: Partial<Record<ImportField, string>>;
}

/** Upsert by key in one transaction; per-row errors are reported, other rows still import. */
export function commitImport(db: Db, sheet: ParsedSheet, req: ImportCommitRequest): ImportCommitResponse {
  const colOf = new Map<ImportField, number>();
  for (const [header, field] of Object.entries(req.mapping)) {
    const idx = sheet.headers.indexOf(header);
    if (idx < 0) throw badRequest(`Mapped column "${header}" not found in sheet`);
    if (colOf.has(field)) throw badRequest(`Field "${field}" is mapped more than once`);
    colOf.set(field, idx);
  }
  if (!colOf.has('title') && !colOf.has('key')) throw badRequest('Map at least the title (and ideally key) column');

  const inputs: RowInput[] = sheet.rows.map((r) => {
    const values: RowInput['values'] = {};
    for (const [field, idx] of colOf) values[field] = r.cells[idx] ?? '';
    return { row: r.n, values };
  });

  const result: ImportCommitResponse = { created: 0, updated: 0, skipped: 0, errors: [], dryRun: req.dryRun };
  const addError = (row: number, message: string) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push({ row, message });
  };

  const statusMap = new Map(Object.entries(req.statusValueMap));
  const mapStatus = (raw: string): AutomationStatus =>
    statusMap.get(raw) ?? normalizeAutomationStatus(raw) ?? 'not_automated';

  try {
    db.transaction((tx) => {
      const existing = new Map(
        tx
          .select({ id: testCases.id, key: testCases.key, jiraKey: testCases.jiraKey, status: testCases.automationStatus })
          .from(testCases)
          .all()
          .map((c) => [c.key, c]),
      );
      const jiraOwner = new Map<string, string>(); // jiraKey -> case key
      for (const c of existing.values()) if (c.jiraKey) jiraOwner.set(c.jiraKey, c.key);
      const seenKeys = new Map<string, number>();
      const now = nowIso();

      for (const { row, values } of inputs) {
        const v = (f: ImportField) => (values[f] ?? '').trim();
        let jiraKey = colOf.has('jiraKey') ? v('jiraKey').toUpperCase() || null : undefined;
        let externalUrl = colOf.has('externalUrl') ? v('externalUrl') || null : undefined;
        if (externalUrl && !/^https?:\/\//i.test(externalUrl)) {
          // trackers often put a bare Jira key in the "Jira" column
          if (jiraKey === undefined && isJiraKey(externalUrl.toUpperCase())) jiraKey = externalUrl.toUpperCase();
          externalUrl = null;
        }
        if (jiraKey && !isJiraKey(jiraKey)) {
          addError(row, `Invalid Jira key "${jiraKey.slice(0, 50)}" ignored`);
          jiraKey = null;
        }
        const title = v('title') || v('key');
        const key = v('key') || jiraKey || title;
        if (!key || !title) {
          result.skipped++;
          addError(row, 'Missing key/title');
          continue;
        }
        const dupOf = seenKeys.get(key);
        if (dupOf !== undefined) {
          result.skipped++;
          addError(row, `Duplicate key "${key.slice(0, 80)}" (first seen on row ${dupOf})`);
          continue;
        }
        seenKeys.set(key, row);

        const candidate = {
          key,
          title,
          suite: colOf.has('suite') ? v('suite') || null : undefined,
          priority: colOf.has('priority') ? normalizePriority(v('priority')) : undefined,
          automationStatus: colOf.has('automationStatus') ? mapStatus(v('automationStatus')) : undefined,
          owner: colOf.has('owner') ? v('owner') || null : undefined,
          tags: colOf.has('tags') ? splitTags(v('tags')) : undefined,
          externalUrl,
          allureFullName: colOf.has('allureFullName') ? v('allureFullName') || null : undefined,
          allureId: colOf.has('allureId') ? v('allureId') || null : undefined,
          jiraKey,
        };
        const parsed = TestCaseCreate.safeParse(candidate);
        if (!parsed.success) {
          result.skipped++;
          addError(row, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300));
          continue;
        }
        const data = parsed.data;
        if (data.jiraKey) {
          const owner = jiraOwner.get(data.jiraKey);
          if (owner !== undefined && owner !== key) {
            result.skipped++;
            addError(row, `Jira key ${data.jiraKey} already belongs to case "${owner.slice(0, 80)}"`);
            continue;
          }
        }

        const current = existing.get(key);
        if (current) {
          if (req.onConflict === 'skip') {
            result.skipped++;
            continue;
          }
          // only mapped columns are written
          const set: Partial<typeof testCases.$inferInsert> = { title: data.title, updatedAt: now };
          if (candidate.suite !== undefined) set.suite = data.suite ?? null;
          if (candidate.priority !== undefined) set.priority = data.priority ?? null;
          if (candidate.automationStatus !== undefined) {
            set.automationStatus = data.automationStatus;
            if (data.automationStatus === 'automated' && current.status !== 'automated') {
              set.automatedAt = now;
              set.automatedVia = 'spreadsheet';
            }
          }
          if (candidate.owner !== undefined) set.owner = data.owner ?? null;
          if (candidate.tags !== undefined) set.tags = data.tags;
          if (candidate.externalUrl !== undefined) set.externalUrl = data.externalUrl ?? null;
          if (candidate.allureFullName !== undefined) set.allureFullName = data.allureFullName ?? null;
          if (candidate.allureId !== undefined) set.allureId = data.allureId ?? null;
          if (candidate.jiraKey !== undefined) set.jiraKey = data.jiraKey ?? null;
          tx.update(testCases).set(set).where(inArray(testCases.id, [current.id])).run();
          if (current.jiraKey && current.jiraKey !== set.jiraKey && set.jiraKey !== undefined) jiraOwner.delete(current.jiraKey);
          if (data.jiraKey) jiraOwner.set(data.jiraKey, key);
          result.updated++;
        } else {
          const inserted = tx
            .insert(testCases)
            .values({
              key: data.key,
              title: data.title,
              suite: data.suite ?? null,
              priority: data.priority ?? null,
              automationStatus: data.automationStatus,
              owner: data.owner ?? null,
              tags: data.tags,
              externalUrl: data.externalUrl ?? null,
              allureFullName: data.allureFullName ?? null,
              allureId: data.allureId ?? null,
              jiraKey: data.jiraKey ?? null,
              source: 'spreadsheet',
              automatedAt: data.automationStatus === 'automated' ? now : null,
              automatedVia: data.automationStatus === 'automated' ? 'spreadsheet' : null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: testCases.id })
            .get();
          existing.set(key, { id: inserted.id, key, jiraKey: data.jiraKey ?? null, status: data.automationStatus });
          if (data.jiraKey) jiraOwner.set(data.jiraKey, key);
          result.created++;
        }
      }
      if (req.dryRun) throw new Rollback();
      recordCoverageSnapshot(tx);
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result;
}
