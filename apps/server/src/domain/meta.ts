import { desc, isNotNull, sql } from 'drizzle-orm';
import type { Meta } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { runs, testCases } from '../db/schema.js';

export function getMeta(db: Db): Meta {
  const suites = db
    .selectDistinct({ v: testCases.suite })
    .from(testCases)
    .where(isNotNull(testCases.suite))
    .orderBy(testCases.suite)
    .all()
    .map((r) => r.v as string);
  const owners = db
    .selectDistinct({ v: testCases.owner })
    .from(testCases)
    .where(isNotNull(testCases.owner))
    .orderBy(testCases.owner)
    .all()
    .map((r) => r.v as string);
  const tags = db
    .all<{ v: string }>(sql`SELECT DISTINCT j.value AS v FROM ${testCases}, json_each(${testCases.tags}) AS j WHERE j.type = 'text' ORDER BY v LIMIT 1000`)
    .map((r) => r.v);
  const branches = db
    .selectDistinct({ v: runs.branch })
    .from(runs)
    .where(isNotNull(runs.branch))
    .orderBy(runs.branch)
    .all()
    .map((r) => r.v as string);
  const runGroups = db
    .select({ name: runs.runGroup, runs: sql<number>`count(*)`, lastRunAt: sql<string>`max(${runs.sortAt})` })
    .from(runs)
    .groupBy(runs.runGroup)
    .orderBy(desc(sql`max(${runs.sortAt})`))
    .all();
  return { suites, owners, tags, branches, runGroups };
}
