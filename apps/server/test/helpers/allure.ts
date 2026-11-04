import type { InjectOptions } from 'fastify';
import type { RunImportResponse } from '@ptd/shared';
import type { TestApp } from './app.js';
import { multipart } from './app.js';

let seq = 0;

export interface ResultSpec {
  fullName: string;
  name?: string;
  status: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
  message?: string;
  start?: number;
  durationMs?: number;
  historyId?: string;
  testCaseId?: string;
  labels?: Array<{ name: string; value: string }>;
  links?: Array<{ name: string; type: string; url?: string }>;
}

export function allureResult(spec: ResultSpec): { filename: string; content: string } {
  seq++;
  const start = spec.start ?? 1_790_000_000_000 + seq * 1000;
  const name = spec.name ?? spec.fullName.split(/[#.]/).pop() ?? spec.fullName;
  const body = {
    uuid: `u-${seq}`,
    historyId: spec.historyId ?? `h-${spec.fullName}`,
    testCaseId: spec.testCaseId,
    fullName: spec.fullName,
    name,
    status: spec.status,
    statusDetails: spec.message ? { message: spec.message, trace: 'trace' } : undefined,
    start,
    stop: start + (spec.durationMs ?? 100),
    labels: spec.labels ?? [],
    parameters: [],
    links: spec.links ?? [],
  };
  return { filename: `${seq}-result.json`, content: JSON.stringify(body) };
}

/** Import a run made of results (individual-file multipart upload). */
export async function importResults(
  t: TestApp,
  specs: ResultSpec[],
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<RunImportResponse> {
  const mp = multipart(fields, specs.map(allureResult));
  const opts: InjectOptions = {
    method: 'POST',
    url: '/api/runs/import',
    payload: mp.payload,
    headers: { ...mp.headers, ...headers },
  };
  const res = await t.app.inject(opts);
  if (res.statusCode !== 201) throw new Error(`import failed ${res.statusCode}: ${res.body}`);
  return res.json<RunImportResponse>();
}

/** Epoch ms for "N days ago at 02:00 UTC" — handy for ordered runs. */
export const daysAgo = (n: number, base = Date.UTC(2026, 9, 1, 2)): number => base - n * 86_400_000;
