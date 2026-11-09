/**
 * "Compare with my sheet": a spreadsheet listing routes (one per row, e.g. route_id, xml,
 * entry_kind, triggers, automated, where, test_files, prs) against what the dashboard counts
 * for the scope picked. Each row is matched to a route by id (the xml file, then the folder,
 * tell apart one id in several modules), then each filled-in column is compared:
 *
 *   kind        the sheet's value names one of the route's kinds or schemes (seda → queue)
 *   triggers    the number of triggers the route has
 *   automated   yes/no against "has a test", or a number against how many triggers do
 *   where       a folder name against the route's folder; merged / PR against where its tests are
 *   testFiles   the test files covering it (by file name), both ways
 *   prs         PR numbers or branches with tests for it
 *
 * Routes on one side only are listed too, with a note when the dashboard knows why (another
 * folder or type than the one picked, or another branch).
 */
import { desc, eq, isNotNull } from 'drizzle-orm';
import {
  TRIGGER_KIND_LABEL,
  type SheetCompareColumns,
  type SheetCompareField,
  type SheetCompareRequest,
  type SheetCompareResponse,
  type SheetCompareRoute,
  type SheetCompareRow,
  type TriggerKind,
  type TriggerRow,
} from '@ptd/shared';
import type { Db } from '../db/client.js';
import { badRequest } from '../errors.js';
import { triggerScans } from '../db/schema.js';
import type { ParsedSheet } from '../import/spreadsheet/parse.js';
import { parsePrLabel } from './prLabel.js';
import { bodyCanName, norm, triggerNames } from './scan.js';
import { routeCoverage } from './routeCoverage.js';
import { listTriggers, unlinkedTests } from './store.js';
import { isRouteScan } from './testScope.js';
import type { SkippedRoute } from './scan.js';

const MAX_ROWS = 20_000;

/** Header → column, for the usual names (route_id, xml, entry_kind, triggers, automated, where, test_files, prs). */
export function detectColumns(headers: readonly string[]): Partial<SheetCompareColumns> {
  const canon = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const find = (...tests: RegExp[]) => {
    for (const re of tests) {
      const h = headers.find((x) => re.test(canon(x)));
      if (h) return h;
    }
    return undefined;
  };
  const out: Partial<SheetCompareColumns> = {
    routeId: find(/^routeid$/, /^route$/, /^routename$/, /^id$/, /route/),
    xml: find(/^xml$/, /xmlfile|routefile|sourcefile|^file$/, /xml/),
    kind: find(/^entrykind$/, /^kind$/, /^type$/, /entry|kind|trigger(type|kind)/),
    triggers: find(/^triggers$/, /^triggercount$|^numtriggers$|^triggers?count$/),
    automated: find(/^automated$/, /automat|tested|covered/),
    where: find(/^where$/, /^folder$|^module$|^location$/),
    testFiles: find(/^testfiles?$/, /^tests$/, /testfile|testpath/),
    prs: find(/^prs?$/, /^pullrequests?$/, /^pr(number|link)s?$/),
  };
  for (const k of Object.keys(out) as Array<keyof SheetCompareColumns>) if (out[k] === undefined) delete out[k];
  return out;
}

const YES = /^(y|yes|true|1|x|✓|✔|done|automated|tested|covered|ja|oui|si)$/i;
const NO = /^(n|no|false|0|-|—|none|not automated|not tested|manual|todo|missing)$/i;

/** "yes" → true, "no" → false, "2" / "2/3" / "2 of 3" → 2, else null. */
function parseAutomated(v: string): boolean | number | null {
  const s = v.trim();
  if (!s) return null;
  const n = /^(\d+)\s*(?:\/|of)?\s*(\d+)?$/i.exec(s);
  if (n) return Number(n[1]);
  if (YES.test(s)) return true;
  if (NO.test(s)) return false;
  return null;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const fileOfTest = (nodeId: string) => nodeId.split('::')[0] ?? nodeId;
const splitList = (v: string) =>
  v
    .split(/[,;\n|]+|\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** A sheet's word for what starts a route → the dashboard's kinds and schemes it can mean. */
function kindMatches(sheet: string, route: SheetCompareRoute): boolean {
  const s = norm(sheet);
  if (!s) return true;
  const names = new Set<string>();
  for (const k of route.kinds) {
    names.add(k);
    names.add(norm(TRIGGER_KIND_LABEL[k]));
  }
  for (const sc of route.schemes) names.add(norm(sc));
  if (route.kinds.includes('queue')) ['seda', 'jms', 'vm', 'activemq', 'queue-worker', 'queue'].forEach((x) => names.add(x));
  if (route.kinds.includes('file')) ['file', 'load', 'load-file', 'sftp', 'ftp', 'file-poll', 'poll'].forEach((x) => names.add(x));
  if (route.kinds.includes('schedule')) ['schedule', 'scheduled', 'quartz', 'quartz2', 'cron', 'timer', 'scheduler'].forEach((x) => names.add(x));
  if (route.kinds.includes('rest')) ['rest', 'http', 'netty-http', 'restlet', 'api'].forEach((x) => names.add(x));
  if (route.kinds.includes('property')) ['property', 'property-only', 'placeholder', 'property-only-uri'].forEach((x) => names.add(x));
  // "sftp placeholder", "file (sftp)": any word of it
  return names.has(s) || s.split('-').some((w) => names.has(w));
}

interface RouteAcc extends SheetCompareRoute {
  key: string;
}

function routesOf(items: readonly TriggerRow[], prNumber: (branch: string) => number | null): RouteAcc[] {
  const by = new Map<string, RouteAcc & { kindSet: Set<TriggerKind>; schemeSet: Set<string>; files: Set<string>; branches: Set<string> }>();
  for (const t of items) {
    if (t.change === 'removed') continue;
    const key = t.routeId ? `${t.module ?? ''}\0${t.routeId}` : `${t.sourceFile}\0${t.key.split('::')[0]}`;
    let r = by.get(key);
    if (!r) {
      r = {
        key,
        routeId: t.routeId,
        module: t.module,
        sourceFile: t.sourceFile,
        line: t.line,
        kinds: [],
        schemes: [],
        triggers: 0,
        tested: 0,
        testedInPrOnly: 0,
        testFiles: [],
        prBranches: [],
        prNumbers: [],
        runVia: null,
        kindSet: new Set(),
        schemeSet: new Set(),
        files: new Set(),
        branches: new Set(),
      };
      by.set(key, r);
    }
    r.triggers++;
    if (!r.runVia && t.runVia?.length) r.runVia = t.runVia;
    r.kindSet.add(t.kind);
    r.schemeSet.add(t.scheme);
    if (t.coveredBy.length > 0) {
      r.tested++;
      if (t.coveredBy.every((c) => c.branch)) r.testedInPrOnly++;
    }
    for (const c of t.coveredBy) {
      r.files.add(fileOfTest(c.test));
      if (c.branch) r.branches.add(c.branch);
    }
  }
  return [...by.values()].map(({ kindSet, schemeSet, files, branches, ...r }) => ({
    ...r,
    runVia: r.tested === 0 ? r.runVia : null,
    kinds: [...kindSet],
    schemes: [...schemeSet],
    testFiles: [...files].sort(),
    prBranches: [...branches].sort(),
    prNumbers: [...branches].map(prNumber).filter((n): n is number => n !== null),
  }));
}

export function compareSheet(db: Db, sheet: ParsedSheet, req: SheetCompareRequest): SheetCompareResponse {
  const cols = req.columns;
  const at = (h: string | null | undefined) => (h ? sheet.headers.indexOf(h) : -1);
  const idx = Object.fromEntries((Object.keys(cols) as Array<keyof SheetCompareColumns>).map((k) => [k, at(cols[k])])) as Record<keyof SheetCompareColumns, number>;
  if (idx.routeId < 0) throw badRequest(`No column "${cols.routeId}" in sheet "${sheet.name}"`);

  // the routes branch picked, else the default one (as every page counts): its triggers, merged tests and PRs into it
  const branch0 = req.branch ?? routeCoverage(db, undefined, req.tests)?.branch;
  const list = listTriggers(db, { branch: branch0, tests: req.tests });
  const prOf = new Map<string, number>();
  for (const s of db.select({ branch: triggerScans.branch, label: triggerScans.label }).from(triggerScans).where(isNotNull(triggerScans.label)).all()) {
    const pr = parsePrLabel(s.label);
    if (pr) prOf.set(s.branch, pr.number);
  }
  const inScope = (t: TriggerRow) => (!req.folder || t.module === req.folder) && (!req.kinds?.length || req.kinds.includes(t.kind));
  const all = routesOf(list.items, (b) => prOf.get(b) ?? null);
  const scoped = routesOf(list.items.filter(inScope), (b) => prOf.get(b) ?? null);
  const byId = new Map<string, RouteAcc[]>();
  for (const r of scoped) if (r.routeId) byId.set(norm(r.routeId), [...(byId.get(norm(r.routeId)) ?? []), r]);
  const anyById = new Map<string, RouteAcc[]>();
  for (const r of all) if (r.routeId) anyById.set(norm(r.routeId), [...(anyById.get(norm(r.routeId)) ?? []), r]);
  const modules = new Set(all.map((r) => r.module).filter((m): m is string => !!m).map(norm));
  const used = new Set<string>();
  const branch = list.routesFrom ?? 'the routes branch';

  // the routes the scan read but doesn't count, with why
  const skipped: SkippedRoute[] = (() => {
    if (!list.routesFrom) return [];
    const scans = db
      .select({ files: triggerScans.files, testsFound: triggerScans.testsFound, otherRoutes: triggerScans.otherRoutes, triggers: triggerScans.triggers, skipped: triggerScans.skippedRoutes })
      .from(triggerScans)
      .where(eq(triggerScans.branch, list.routesFrom))
      .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
      .all();
    const latest = scans.find((r) => isRouteScan({ ...r, id: 0, branch: '', label: null, scannedAt: '', triggerCount: r.triggers.length }));
    return latest?.skipped ?? [];
  })();
  const skippedById = new Map<string, SkippedRoute[]>();
  for (const r of skipped) if (r.routeId) skippedById.set(norm(r.routeId), [...(skippedById.get(norm(r.routeId)) ?? []), r]);
  const allIds = [...new Set(all.map((r) => r.routeId).filter((x): x is string => !!x))];

  // the test files read (merged tests): those linked to some trigger, and the unlinked ones with what was read in them
  const unlinked = unlinkedTests(db, { branch: branch0, tests: req.tests }).tests;
  const filesRead = new Set([...list.items.flatMap((t) => t.coveredBy.filter((c) => !c.branch).map((c) => baseName(fileOfTest(c.test)))), ...unlinked.map((t) => baseName(fileOfTest(t.id)))]);
  /** Why a test file the sheet names doesn't cover this route here. */
  const whyFileNotLinked = (file: string, route: RouteAcc): string => {
    const name = baseName(file);
    if (!filesRead.has(name)) return `${name} isn't in the test scan of ${list.testsFrom ?? 'the tests branch'}`;
    const strays = unlinked.filter((t) => baseName(fileOfTest(t.id)) === name);
    if (strays.length) {
      // a name of this route used only as a plain word in a test body: too ordinary to count on its own
      const names = list.items.filter((t) => (t.routeId ? `${t.module ?? ''}\0${t.routeId}` : '') === route.key).flatMap((t) => triggerNames(t));
      const weak = strays.flatMap((t) => t.strings).find((w) => names.some((x) => x.n === norm(w) && !bodyCanName(x.n, x.kind)));
      if (weak) {
        const uri = names.find((x) => x.kind === 'uri')?.n;
        return `${name} says "${weak}", a name of this route, but only as a plain word in a test body, which is too ordinary to count: label the test with it (@pytest.mark…, allure.label)${uri ? ` or write "${uri}"` : ''}`;
      }
      const words = [...new Set(strays.flatMap((t) => t.strings))].slice(0, 8);
      return `${name} was read, ${strays.length === 1 ? 'its test names' : `its ${strays.length} unlinked tests name`} ${words.length ? words.map((w) => `"${w}"`).join(', ') : 'nothing'}: none of them is a name of this route`;
    }
    return `${name} was read; its tests cover other routes, not this one`;
  };

  /** Why a route id in the sheet isn't among the routes counted here. */
  const whyNotCounted = (routeId: string): string => {
    const n = norm(routeId);
    const elsewhere = anyById.get(n);
    if (elsewhere?.length)
      return `Counted on ${branch}, but outside the folder/types picked: ${elsewhere.map((r) => `${r.module ? `${r.module}/` : ''} ${r.kinds.map((k) => TRIGGER_KIND_LABEL[k]).join(', ')}`.trim()).join('; ')}`;
    const skip = skippedById.get(n);
    if (skip?.length) return `In ${skip[0]!.file}:${skip[0]!.line}, not counted: it ${skip[0]!.reason}`;
    const close = closest(routeId, allIds);
    return [
      `No route with this id in the XML scanned on ${branch}`,
      close ? `closest id there: ${close}` : null,
      'it may be defined in Java/Kotlin DSL, under src/test, or only on another branch',
    ]
      .filter(Boolean)
      .join('; ');
  };

  const rows: SheetCompareRow[] = [];
  const fieldCounts: Record<SheetCompareField, number> = { kind: 0, triggers: 0, automated: 0, where: 0, testFiles: 0, prs: 0 };
  for (const row of sheet.rows.slice(0, MAX_ROWS)) {
    const cell = (k: keyof SheetCompareColumns) => (idx[k] >= 0 ? (row.cells[idx[k]] ?? '').trim() : '');
    const routeId = cell('routeId');
    if (!routeId) continue;
    const sheetValues: Record<string, string> = {};
    for (const k of Object.keys(cols) as Array<keyof SheetCompareColumns>) if (idx[k] >= 0) sheetValues[k] = cell(k);

    // the route this row is about: by id, then the xml file, then the folder
    let candidates = (byId.get(norm(routeId)) ?? []).filter((r) => !used.has(r.key));
    const xml = cell('xml');
    if (candidates.length > 1 && xml) {
      const byFile = candidates.filter((r) => r.sourceFile === xml || r.sourceFile.endsWith(`/${xml.replace(/^\.?\//, '')}`) || baseName(r.sourceFile) === baseName(xml));
      if (byFile.length) candidates = byFile;
    }
    const where = cell('where');
    if (candidates.length > 1 && where) {
      const byFolder = candidates.filter((r) => r.module && norm(r.module) === norm(where));
      if (byFolder.length) candidates = byFolder;
    }
    const route = candidates[0];
    if (!route) {
      rows.push({ status: 'sheetOnly', routeId, sheetRow: row.n, diffs: [], note: whyNotCounted(routeId), sheet: sheetValues, dashboard: null });
      continue;
    }
    used.add(route.key);
    const { key: _key, ...dash } = route;
    const diffs: SheetCompareRow['diffs'] = [];
    const add = (field: SheetCompareField, sheetV: string, dashV: string) => {
      diffs.push({ field, sheet: sheetV, dashboard: dashV });
      fieldCounts[field]++;
    };

    const kind = cell('kind');
    if (kind && !kindMatches(kind, dash)) add('kind', kind, [...dash.kinds.map((k) => TRIGGER_KIND_LABEL[k]), ...dash.schemes].join(', '));

    const trig = cell('triggers');
    if (trig && /^\d+$/.test(trig) && Number(trig) !== dash.triggers) add('triggers', trig, String(dash.triggers));

    const auto = parseAutomated(cell('automated'));
    const describe = () =>
      dash.tested === 0
        ? `no test names it${dash.runVia ? ` (it runs via ${dash.runVia.join(' → ')}, which is tested)` : ''}`
        : `${dash.tested} of ${dash.triggers} trigger${dash.triggers === 1 ? '' : 's'} tested${dash.testedInPrOnly ? ` (${dash.testedInPrOnly} only in a PR)` : ''}`;
    if (auto === true && dash.tested === 0) add('automated', cell('automated'), describe());
    else if (auto === false && dash.tested > 0) add('automated', cell('automated'), describe());
    else if (typeof auto === 'number' && auto !== dash.tested) add('automated', cell('automated'), describe());

    if (where) {
      const w = norm(where);
      if (modules.has(w) || (dash.module && w === norm(dash.module))) {
        if (!dash.module || w !== norm(dash.module)) add('where', where, dash.module ? `${dash.module}/` : 'no folder');
      } else if (/\b(pr|prs|unmerged|open|not-merged|pending)\b/.test(w.replace(/-/g, ' ')) || /^pr/.test(w)) {
        if (dash.tested === 0 || dash.testedInPrOnly < dash.tested) add('where', where, dash.tested === 0 ? 'no test' : 'merged tests');
      } else if (/\b(merged|main|master|develop|core|dev)\b/.test(w.replace(/-/g, ' '))) {
        if (dash.tested > 0 && dash.testedInPrOnly === dash.tested) add('where', where, `only in PRs (${dash.prBranches.join(', ')})`);
      }
    }

    const files = splitList(cell('testFiles'));
    if (files.length) {
      const mine = new Set(dash.testFiles.map(baseName));
      const theirs = new Set(files.map(baseName));
      const missing = [...theirs].filter((f) => !mine.has(f));
      const extra = [...mine].filter((f) => !theirs.has(f));
      if (missing.length || extra.length)
        add('testFiles', files.join(', '), [...missing.map((f) => whyFileNotLinked(f, route)), extra.length ? `also covered by ${extra.join(', ')}` : null].filter(Boolean).join(' · '));
    }

    const prs = cell('prs');
    if (prs) {
      const nums = [...prs.matchAll(/#?(\d+)/g)].map((m) => Number(m[1]));
      const branches = splitList(prs).filter((x) => /[a-z]/i.test(x) && !/^#?\d+$/.test(x) && !/^https?:/.test(x));
      const missingNums = nums.filter((n) => !dash.prNumbers.includes(n));
      const missingBranches = branches.filter((b) => !dash.prBranches.includes(b));
      if (missingNums.length || missingBranches.length)
        add(
          'prs',
          prs,
          dash.prBranches.length
            ? `PRs with tests for it: ${dash.prBranches.map((b) => (prOf.has(b) ? `#${prOf.get(b)} ${b}` : b)).join(', ')}`
            : 'no PR scanned has a test for it',
        );
    }

    rows.push({ status: diffs.length ? 'differs' : 'match', routeId, sheetRow: row.n, diffs, note: null, sheet: sheetValues, dashboard: dash });
  }

  // what the sheet covers, to say why a route may be missing from it
  const sheetCells = (k: keyof SheetCompareColumns) => (idx[k] >= 0 ? sheet.rows.map((r) => (r.cells[idx[k]] ?? '').trim()).filter(Boolean) : []);
  const sheetIds = new Map<string, number>();
  for (const v of sheetCells('routeId')) sheetIds.set(norm(v), (sheetIds.get(norm(v)) ?? 0) + 1);
  const sheetKinds = [...new Set(sheetCells('kind'))];
  const sheetFiles = new Set(sheetCells('xml').map((x) => baseName(x).toLowerCase()));
  const sheetWheres = new Set(sheetCells('where').map(norm));
  const whyNotInSheet = (r: RouteAcc): string => {
    const reasons: string[] = [];
    if (!r.routeId) reasons.push('it has no route id, so a sheet listing routes by id has no name for it');
    else if (sheetIds.has(norm(r.routeId))) {
      const here = scoped.filter((x) => x.routeId && norm(x.routeId) === norm(r.routeId!));
      reasons.push(
        `the sheet lists ${r.routeId} ${sheetIds.get(norm(r.routeId)) === 1 ? 'once' : `${sheetIds.get(norm(r.routeId))} times`}, but it is in ${here.length} folders here (${here.map((x) => `${x.module ?? '—'}/`).join(', ')})`,
      );
    }
    if (sheetKinds.length && !sheetKinds.some((k) => kindMatches(k, r)))
      reasons.push(`the sheet has no ${r.kinds.map((k) => TRIGGER_KIND_LABEL[k]).join('/')} routes (its ${cols.kind} values: ${sheetKinds.slice(0, 6).join(', ')}${sheetKinds.length > 6 ? '…' : ''})`);
    if (sheetFiles.size) {
      reasons.push(sheetFiles.has(baseName(r.sourceFile).toLowerCase()) ? `the sheet lists other routes from ${baseName(r.sourceFile)}, not this one` : `no row of the sheet is from ${baseName(r.sourceFile)}`);
    }
    if (r.module && sheetWheres.size && [...sheetWheres].some((w) => modules.has(w)) && !sheetWheres.has(norm(r.module))) reasons.push(`no row of the sheet is in ${r.module}/`);
    if (r.kinds.includes('property')) reasons.push('its URI is only a property that no .properties file sets, so a tool reading values may skip it');
    if (r.kinds.includes('direct')) reasons.push('another route calls it (direct:), so a list of entry points may leave it out');
    return `${reasons.length ? `${reasons.join('; ')}. ` : ''}Found at ${r.sourceFile}:${r.line}.`.replace(/^./, (c) => c.toUpperCase());
  };

  for (const r of scoped) {
    if (used.has(r.key)) continue;
    const { key: _key, ...dash } = r;
    rows.push({
      status: 'dashboardOnly',
      routeId: r.routeId ?? `${baseName(r.sourceFile)} (no id)`,
      sheetRow: null,
      diffs: [],
      note: whyNotInSheet(r),
      sheet: null,
      dashboard: dash,
    });
  }

  const count = (s: SheetCompareRow['status']) => rows.filter((r) => r.status === s).length;
  return {
    routesFrom: list.routesFrom,
    testsFrom: list.testsFrom,
    folder: req.folder ?? null,
    kinds: req.kinds?.length ? req.kinds : null,
    columns: cols,
    counts: {
      sheetRows: rows.filter((r) => r.sheetRow !== null).length,
      routes: scoped.length,
      match: count('match'),
      differs: count('differs'),
      sheetOnly: count('sheetOnly'),
      dashboardOnly: count('dashboardOnly'),
    },
    fieldCounts,
    rows,
  };
}

/** The id most like `id` (a typo, another separator, a prefix): within 2 edits, or one containing the other. */
function closest(id: string, ids: readonly string[]): string | null {
  const a = norm(id);
  let best: { id: string; d: number } | null = null;
  for (const other of ids) {
    const b = norm(other);
    const d = a.includes(b) || b.includes(a) ? Math.abs(a.length - b.length) / 10 + 1 : levenshtein(a, b, 3);
    if (d <= 2 && (!best || d < best.d)) best = { id: other, d };
  }
  return best?.id ?? null;
}

function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      min = Math.min(min, cur[j]!);
    }
    if (min > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}
