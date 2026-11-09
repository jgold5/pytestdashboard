/**
 * Runs the dashboard's scanner (and the Overview's coverage/status code) on generated cases.
 *
 *   cd apps/server && npx tsx ../../tools/verify_counts/run_scanner.ts <case-dir>...   (compare.py runs it)
 *
 * Each <case-dir> holds repo/ (routes, properties, tests on main) and optionally pr/ (the test
 * repo's files on an open PR into main). Prints one JSON line per case: the scanner's triggers
 * with their main-branch coverage, the Overview status of each, and invariant violations.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepository } from '../../apps/server/src/triggers/scan.ts';
import { routeCoverage, routeOverview, scopeCounts } from '../../apps/server/src/triggers/routeCoverage.ts';
import { saveScan } from '../../apps/server/src/triggers/store.ts';
import { openDatabase } from '../../apps/server/src/db/client.ts';
import { classify } from '../../apps/server/src/triggers/upload.ts';

type F = { path: string; text: string };

/** Files as an upload reads them (upload.ts classify); __routes__/ and __tests__/ are the two repos of a real comparison. */
function walk(root: string): { xml: F[]; properties: F[]; tests: F[] } {
  const out = { xml: [] as F[], properties: [] as F[], tests: [] as F[] };
  if (!fs.existsSync(root)) return out;
  const sides: Array<[string, 'routes' | 'tests' | null]> = [
    [path.join(root, '__routes__'), 'routes'],
    [path.join(root, '__tests__'), 'tests'],
  ];
  const bases = sides.some(([d]) => fs.existsSync(d)) ? sides.filter(([d]) => fs.existsSync(d)) : ([[root, null]] as Array<[string, null]>);
  const rec = (dir: string, only: 'routes' | 'tests' | null) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (fs.statSync(full).isDirectory()) {
        if (classify(`${rel}/x.py`) !== null) rec(full, only); // build output, node_modules, .git… are never read
        continue;
      }
      const cls = classify(rel);
      if (!cls || (only === 'routes' && cls === 'tests') || (only === 'tests' && cls !== 'tests')) continue;
      if (fs.statSync(full).size > 5 * 1024 * 1024) continue;
      out[cls].push({ path: rel, text: fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '') });
    }
  };
  for (const [base, only] of bases) rec(base, only);
  const by = (a: F, b: F) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  out.xml.sort(by);
  out.properties.sort(by);
  out.tests.sort(by);
  return out;
}

const KINDS = ['file', 'schedule', 'direct', 'queue', 'kafka', 'rest', 'property'] as const;

for (const dir of process.argv.slice(2)) {
  const repo = walk(path.join(dir, 'repo'));
  const pr = walk(path.join(dir, 'pr'));
  const out = scanRepository(repo);
  const prOut = scanRepository({ xml: [], properties: [], tests: pr.tests });
  const violations: string[] = [];

  // Overview statuses through the real store + coverage code
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-oracle-'));
  const h = openDatabase(tmp);
  const statuses = new Map<string, string>();
  try {
    const t0 = Date.UTC(2026, 0, 1);
    const routesOnly = { ...out, tests: [], testsFound: 0 };
    saveScan(h.db, { branch: 'main', label: 'acme/routes', only: 'routes' }, routesOnly, { xml: repo.xml.length, properties: repo.properties.length, tests: 0 }, new Date(t0));
    const testsOnly = { ...out, triggers: [], otherRoutes: 0 };
    saveScan(h.db, { branch: 'main', label: 'acme/tests', only: 'tests' }, testsOnly, { xml: 0, properties: 0, tests: repo.tests.length }, new Date(t0 + 1000));
    if (pr.tests.length) {
      saveScan(h.db, { branch: 'feature/pr-1', label: 'acme/tests PR #1 → main', only: 'tests' }, { ...prOut, triggers: [], otherRoutes: 0 }, { xml: 0, properties: 0, tests: pr.tests.length }, new Date(t0 + 2000));
      // a hand-scanned feature branch with no PR label: must not count at all
      saveScan(h.db, { branch: 'feature/loose', label: 'acme/tests', only: 'tests' }, { ...prOut, triggers: [], otherRoutes: 0 }, { xml: 0, properties: 0, tests: pr.tests.length }, new Date(t0 + 3000));
      // a PR into another branch: must not count for main
      saveScan(h.db, { branch: 'feature/pr-2', label: 'acme/tests PR #2 → release', only: 'tests' }, { ...prOut, triggers: [], otherRoutes: 0 }, { xml: 0, properties: 0, tests: pr.tests.length }, new Date(t0 + 4000));
    }
    const cov = routeCoverage(h.db);
    if (!cov) throw new Error('no coverage');
    for (const r of cov.rows) statuses.set(r.key, r.status);
    // --- invariants
    const all = scopeCounts(cov);
    if (all.total !== out.triggers.length) violations.push(`scopeCounts.total ${all.total} != triggers ${out.triggers.length}`);
    if (all.tested + all.branch + all.none !== all.total) violations.push('tested+branch+none != total');
    if (cov.automated !== all.tested || cov.inProgress !== all.branch) violations.push('cov.automated/inProgress != scopeCounts');
    if (new Set(cov.rows.map((r) => r.key)).size !== cov.rows.length) violations.push('duplicate row keys');
    const ov = routeOverview(h.db, { limit: 50 } as never);
    const sumKinds = ov.kindCounts.reduce((s, k) => s + k.triggers, 0);
    const sumKindsTested = ov.kindCounts.reduce((s, k) => s + k.tested, 0);
    if (sumKinds !== all.total) violations.push(`sum(kindCounts) ${sumKinds} != total ${all.total}`);
    if (sumKindsTested !== all.tested + all.branch) violations.push(`sum(kindCounts.tested) ${sumKindsTested} != tested+branch ${all.tested + all.branch}`);
    if (ov.counts.tested + ov.counts.branch + ov.counts.none !== ov.triggerRepo!.triggers) violations.push('overview counts != triggerRepo.triggers');
    const allMod = cov.rows.every((r) => r.module);
    const sumFolders = ov.folders.reduce((s, f) => s + f.triggers, 0);
    if (allMod && sumFolders !== all.total) violations.push(`sum(folders) ${sumFolders} != total ${all.total}`);
    if (!allMod && sumFolders + cov.rows.filter((r) => !r.module).length !== all.total) violations.push('folders + module-less != total');
    const allKinds = routeOverview(h.db, { limit: 50, kinds: [...KINDS] } as never);
    if (JSON.stringify(allKinds.counts) !== JSON.stringify(ov.counts)) violations.push('kinds=all differs from unfiltered');
    let perKind = 0;
    for (const k of KINDS) {
      const c = scopeCounts(cov, { kinds: [k] });
      perKind += c.total;
      const o = routeOverview(h.db, { limit: 50, kinds: [k] } as never);
      if (o.counts.tested + o.counts.branch + o.counts.none !== c.total) violations.push(`kind ${k}: overview counts != scopeCounts`);
      const kc = ov.kindCounts.find((x) => x.kind === k);
      if ((kc?.triggers ?? 0) !== c.total || (kc?.tested ?? 0) !== c.tested + c.branch) violations.push(`kind ${k}: kindCounts mismatch`);
    }
    if (perKind !== all.total) violations.push(`sum per-kind ${perKind} != total`);
    for (const f of ov.folders) {
      const c = scopeCounts(cov, { folder: f.folder });
      if (c.total !== f.triggers || c.tested + c.branch !== f.tested || c.branch !== f.unmerged) violations.push(`folder ${f.folder}: folders entry != scopeCounts`);
      const o = routeOverview(h.db, { limit: 50, folder: f.folder } as never);
      if (o.triggerRepo!.triggers !== c.total) violations.push(`folder ${f.folder}: overview total`);
      const fk = o.kindCounts.reduce((s, k) => s + k.triggers, 0);
      if (fk !== c.total) violations.push(`folder ${f.folder}: kindCounts sum ${fk} != ${c.total}`);
    }
    // a PR's tests: every 'branch' row is one only a PR test covers
    const covMain = new Map(out.triggers.map((t) => [t.key, t.coveredBy.length > 0]));
    for (const r of cov.rows) if ((r.status === 'tested') !== covMain.get(r.key)) violations.push(`row ${r.key}: status ${r.status} but scanRepository coveredBy=${covMain.get(r.key)}`);
  } finally {
    h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // PR coverage per trigger as scanRepository sees it (full PR test set), for the oracle's branch status
  const prCov = scanRepository({ xml: repo.xml, properties: repo.properties, tests: pr.tests });
  const prCovered = new Map(prCov.triggers.map((t) => [t.key, t.coveredBy.map((c) => c.test)]));

  console.log(
    JSON.stringify({
      dir,
      otherRoutes: out.otherRoutes,
      tests: out.tests.map((t) => t.id),
      violations,
      triggers: out.triggers.map((t) => ({
        key: t.key,
        file: t.sourceFile,
        routeId: t.routeId,
        module: t.module,
        input: t.input,
        line: t.line,
        kind: t.kind,
        scheme: t.scheme,
        patternKind: t.patternKind,
        filePattern: t.filePattern,
        condition: t.condition,
        uri: t.uri,
        coveredBy: [...new Set(t.coveredBy.map((c) => c.test))].sort(),
        via: Object.fromEntries(t.coveredBy.map((c) => [c.test, c.via])),
        prCoveredBy: prCovered.get(t.key) ?? [],
        status: statuses.get(t.key) ?? null,
      })),
    }),
  );
}
