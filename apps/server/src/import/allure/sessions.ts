/**
 * Recover individual test runs from results that were collected into one folder
 * (a port of allure-history's runs.py, from the allureparser project).
 *
 * A folder that accumulates results from many runs doesn't record where one run
 * ends. allure-pytest does record, on every result, the host and process id of
 * the pytest process that produced it (see parse.ts `sessionId`). Runs are
 * rebuilt from that:
 *
 * 1. Results are grouped by session (host:pid), in start-time order.
 * 2. A session is split where a test shows up again after other tests ran:
 *    pytest runs each test once and reruns a failure immediately, so a later
 *    repeat means the same pid was reused by a new run.
 * 3. Sessions on the same host that overlap in time and ran disjoint sets of
 *    tests are one run: the workers of a parallel (pytest-xdist) run.
 *
 * Results with no session information are grouped by the folder they came from.
 */
import type { ParsedResult } from './parse.js';

export interface DetectedRun {
  host: string;
  /** Number of pytest processes (xdist workers) that make up the run; 0 = no session info. */
  workers: number;
  start: number | null;
  stop: number | null;
  results: ParsedResult[];
}

/** Identity of a test across runs: Allure's historyId, like allure-history. */
export const testKey = (r: ParsedResult): string => r.historyId ?? r.fullName ?? r.name;

/** Start-time order; results without a start time sort first (as allure-history). */
function compareTime(a: ParsedResult, b: ParsedResult): number {
  return (
    Number(a.start !== null) - Number(b.start !== null) ||
    (a.start ?? 0) - (b.start ?? 0) ||
    Number(a.stop !== null) - Number(b.stop !== null) ||
    (a.stop ?? 0) - (b.stop ?? 0)
  );
}

class Segment {
  readonly results: ParsedResult[] = [];
  readonly keys = new Set<string>();
  start: number | null = null;
  stop: number | null = null;

  constructor(
    readonly host: string,
    readonly session: string,
  ) {}

  add(r: ParsedResult): void {
    this.results.push(r);
    this.keys.add(testKey(r));
    for (const t of [r.start, r.stop]) {
      if (t === null) continue;
      this.start = this.start === null ? t : Math.min(this.start, t);
      this.stop = this.stop === null ? t : Math.max(this.stop, t);
    }
  }
}

function splitSession(host: string, session: string, results: ParsedResult[]): Segment[] {
  const segments = [new Segment(host, session)];
  let previous: string | null = null;
  for (const r of [...results].sort(compareTime)) {
    const key = testKey(r);
    let current = segments[segments.length - 1] as Segment;
    if (current.keys.has(key) && key !== previous) {
      current = new Segment(host, session);
      segments.push(current);
    }
    current.add(r);
    previous = key;
  }
  return segments;
}

interface Building extends DetectedRun {
  sessions: Set<string>;
  keys: Set<string>;
}

const overlaps = (a: { start: number | null; stop: number | null }, b: { start: number | null; stop: number | null }): boolean =>
  a.start !== null && b.start !== null && a.stop !== null && b.stop !== null && a.start <= b.stop && b.start <= a.stop;

/** Split results into runs, oldest first. */
export function detectRuns(results: readonly ParsedResult[]): DetectedRun[] {
  const bySession = new Map<string, { host: string; session: string; results: ParsedResult[] }>();
  const seen = new Set<string>();
  for (const r of results) {
    // the same execution twice (e.g. copied into the folder twice) counts once
    const ident = JSON.stringify([testKey(r), r.status, r.start, r.stop, r.message]);
    if (seen.has(ident)) continue;
    seen.add(ident);
    const session = r.session ?? '';
    const host = session ? session.slice(0, session.lastIndexOf(':')) : '';
    const group = session ? `s\0${session}` : `f\0${r.source ?? ''}`;
    let g = bySession.get(group);
    if (!g) bySession.set(group, (g = { host, session, results: [] }));
    g.results.push(r);
  }

  const segments: Segment[] = [];
  for (const g of bySession.values()) {
    if (g.session) segments.push(...splitSession(g.host, g.session, g.results));
    else {
      const seg = new Segment('', '');
      for (const r of [...g.results].sort(compareTime)) seg.add(r);
      segments.push(seg);
    }
  }
  segments.sort((a, b) => Number(a.start !== null) - Number(b.start !== null) || (a.start ?? 0) - (b.start ?? 0));

  const runs: Building[] = [];
  for (const seg of segments) {
    let target: Building | undefined;
    if (seg.session) {
      target = runs.find(
        (run) => run.host === seg.host && run.sessions.size > 0 && overlaps(run, seg) && ![...seg.keys].some((k) => run.keys.has(k)),
      );
    }
    if (!target) {
      target = { host: seg.host, workers: 0, start: null, stop: null, results: [], sessions: new Set(), keys: new Set() };
      runs.push(target);
    }
    if (seg.session) target.sessions.add(seg.session);
    target.results.push(...seg.results);
    for (const k of seg.keys) target.keys.add(k);
    for (const t of [seg.start, seg.stop]) {
      if (t === null) continue;
      target.start = target.start === null ? t : Math.min(target.start, t);
      target.stop = target.stop === null ? t : Math.max(target.stop, t);
    }
  }

  runs.sort((a, b) => Number(a.start !== null) - Number(b.start !== null) || (a.start ?? 0) - (b.start ?? 0));
  return runs.map(({ host, sessions, start, stop, results: rs }) => ({ host, workers: sessions.size, start, stop, results: rs }));
}
