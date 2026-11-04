/**
 * Performance check for the history matrix (SPEC target: 50 rows × 60 runs on
 * 5k cases × 300 runs in < 200 ms). Skipped unless PERF=1:
 *   PERF=1 pnpm --filter @ptd/server test perf
 */
import { describe, expect, it } from 'vitest';
import type { HistoryMatrix, TestCaseDetail } from '@ptd/shared';
import { createTestApp } from './helpers/app.js';

const CASES = 5000;
const RUNS = 300;

describe.skipIf(process.env.PERF !== '1')('perf: history matrix', () => {
  it('meets the latency target', async () => {
    const t = await createTestApp();
    try {
      const s = t.dbHandle.sqlite;
      const now = new Date().toISOString();
      const t0 = performance.now();
      s.transaction(() => {
        const ic = s.prepare(
          `INSERT INTO test_cases (key, title, suite, automation_status, tags, source, created_at, updated_at) VALUES (?, ?, ?, 'automated', '[]', 'allure', ?, ?)`,
        );
        for (let c = 0; c < CASES; c++) ic.run(`tests.api.m${c % 50}#t${c}`, `t${c}`, `suite${c % 20}`, now, now);
        const ir = s.prepare(
          `INSERT INTO runs (name, run_group, branch, imported_at, sort_at, total) VALUES (?, 'tests/api', 'main', ?, ?, ?)`,
        );
        const res = s.prepare(
          `INSERT INTO test_results (run_id, test_case_id, name, status, duration_ms, failure_signature) VALUES (?, ?, 'x', ?, 100, ?)`,
        );
        for (let r = 1; r <= RUNS; r++) {
          const at = new Date(Date.UTC(2026, 0, 1) + r * 3_600_000).toISOString();
          ir.run(`run ${r}`, at, at, CASES);
          for (let c = 1; c <= CASES; c++) {
            const flaky = c % 97 === 0 && (r + c) % 3 === 0;
            const broken = c % 501 === 0;
            const status = flaky || broken ? 'failed' : 'passed';
            res.run(r, c, status, status === 'failed' ? 'abc123def456' : null);
          }
        }
      })();
      const seedMs = performance.now() - t0;

      // warm-up then measure
      await t.app.inject({ url: '/api/history/matrix?runGroup=tests/api&runs=60&pageSize=50' });
      const timings: number[] = [];
      let body: HistoryMatrix | undefined;
      for (let i = 0; i < 5; i++) {
        const a = performance.now();
        const res = await t.app.inject({ url: '/api/history/matrix?runGroup=tests/api&runs=60&pageSize=50' });
        timings.push(performance.now() - a);
        body = res.json<HistoryMatrix>();
      }
      const all = performance.now();
      await t.app.inject({ url: '/api/history/matrix?runGroup=tests/api&runs=60&pageSize=50&onlyUnstable=false' });
      const allMs = performance.now() - all;
      const d = performance.now();
      const detail = (await t.app.inject({ url: '/api/test-cases/97' })).json<TestCaseDetail>();
      const detailMs = performance.now() - d;

      // Pipeline stage is computed per case on read: list, filter, summary and report.
      const timed = async (url: string) => {
        await t.app.inject({ url });
        const a = performance.now();
        const res = await t.app.inject({ url });
        expect(res.statusCode).toBe(200);
        return performance.now() - a;
      };
      const listMs = await timed('/api/test-cases?pageSize=50&sort=lastRun&order=desc');
      const stageMs = await timed('/api/test-cases?pipelineStage=ready_to_merge&pageSize=50');
      const summaryMs = await timed('/api/summary');
      const reportMs = await timed('/api/report?periodDays=90');
      console.log(
        `[perf] list ${listMs.toFixed(1)} ms; stage filter ${stageMs.toFixed(1)} ms; summary ${summaryMs.toFixed(1)} ms; report ${reportMs.toFixed(1)} ms`,
      );
      expect(Math.max(listMs, stageMs)).toBeLessThan(500);
      expect(Math.max(summaryMs, reportMs)).toBeLessThan(2000);

      timings.sort((a, b) => a - b);
      const median = timings[2]!;
      console.log(
        `[perf] seeded ${CASES}×${RUNS} in ${seedMs.toFixed(0)} ms; matrix (unstable) median ${median.toFixed(1)} ms; ` +
          `matrix (all rows) ${allMs.toFixed(1)} ms; case detail ${detailMs.toFixed(1)} ms`,
      );
      expect(body?.runs).toHaveLength(60);
      expect(body?.rows).toHaveLength(50);
      expect(detail.history).toHaveLength(100);
      expect(median).toBeLessThan(200);
    } finally {
      await t.close();
    }
  }, 300_000);
});
