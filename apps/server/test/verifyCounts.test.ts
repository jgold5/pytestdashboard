/**
 * The counting rules checked against an independent implementation (tools/verify_counts/oracle.py,
 * written from the documented rules with Python's own XML and Python parsers) on generated repos:
 * every trigger, its kind, whether a test covers it, and its Overview status must agree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const compare = path.resolve(here, '../../../tools/verify_counts/compare.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!hasPython)('counts agree with an independent implementation', () => {
  for (const [name, args] of [
    ['realistic repos', ['--seeds', '0:40']],
    ['repos full of edge cases', ['--seeds', '1000:1040', '--probes']],
  ] as const) {
    it(name, () => {
      const work = mkdtempSync(path.join(os.tmpdir(), 'ptd-verify-'));
      try {
        const out = execFileSync('python3', [compare, ...args, '--work', path.join(work, 'cases'), '--out', path.join(work, 'report.json'), '--strict'], { encoding: 'utf8', timeout: 120_000 });
        expect(out).toMatch(/missing-in-scanner 0 {2}extra-in-scanner 0/);
        expect(out).toMatch(/FP 0 {2}FN 0/);
        expect(out).toContain('invariant_violations: 0');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }, 150_000);
  }

  it('renaming for sharing (verify-counts --share) never changes a count', () => {
    const share = path.resolve(here, '../../../tools/verify_counts/share.py');
    for (const args of [['0:20'], ['1000:1020', '--probes']]) {
      const out = execFileSync('python3', [share, '--selftest', ...args], { encoding: 'utf8', timeout: 120_000 });
      expect(out).toMatch(/, 0 changed by renaming/);
    }
  }, 260_000);
});
