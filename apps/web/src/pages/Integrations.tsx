import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleCheck, CircleDashed, CircleX, GitBranch, RefreshCw, Ticket, TriangleAlert } from 'lucide-react';
import type { IntegrationName, IntegrationStatus } from '@ptd/shared';
import { invalidateAfterSync, useIntegrations, useSyncIntegration } from '../api/hooks';
import { ApiError } from '../api/client';
import { cn, fmtDateTime, fmtNumber, fmtRelative } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ErrorState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/misc';
import { Skeleton } from '../components/ui/skeleton';
import { Tooltip } from '../components/ui/tooltip';

/** Env var names only — credentials are configured on the server, never in the browser. */
const INFO: Record<IntegrationName, { title: string; icon: typeof GitBranch; blurb: string; required: string[][]; optional: string[] }> = {
  github: {
    title: 'GitHub',
    icon: GitBranch,
    blurb: 'Links open and recently merged PRs to test cases (by Jira key, allure markers or new test functions) and tracks review state, unresolved threads and CI checks.',
    required: [['GITHUB_TOKEN', 'GITHUB_REPOS']],
    optional: ['GITHUB_API_URL', 'GITHUB_TEST_PATH_GLOBS', 'GITHUB_SYNC_INTERVAL_MINUTES'],
  },
  jira: {
    title: 'Jira / Xray',
    icon: Ticket,
    blurb: 'Imports Jira Test issues as test cases (key, summary, component, labels, assignee, priority) and reads automation status from a custom field or the Xray test type.',
    required: [['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'], ['JIRA_BASE_URL', 'JIRA_PAT']],
    optional: ['JIRA_JQL', 'JIRA_AUTOMATION_FIELD', 'XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET', 'JIRA_SYNC_INTERVAL_MINUTES'],
  },
};

export default function IntegrationsPage() {
  const q = useIntegrations();
  const qc = useQueryClient();
  const prev = useRef<Record<string, IntegrationStatus['state']>>({});

  // When a sync finishes (running → idle/error), refresh data across the app and tell the user.
  useEffect(() => {
    for (const i of q.data ?? []) {
      const was = prev.current[i.name];
      if (was === 'running' && i.state !== 'running') {
        if (i.state === 'error') toast.error(`${INFO[i.name].title} sync failed`, { description: i.lastError ?? undefined });
        else {
          toast.success(`${INFO[i.name].title} sync finished`);
          invalidateAfterSync(qc);
        }
      }
      prev.current[i.name] = i.state;
    }
  }, [q.data, qc]);

  return (
    <>
      <PageHeader title="Integrations" description="Sync test cases from Jira/Xray and automation PRs from GitHub. Credentials are configured via server environment variables only." />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(['github', 'jira'] as const).map((name) => {
            const s = q.data.find((i) => i.name === name);
            return <IntegrationCard key={name} name={name} s={s} />;
          })}
        </div>
      )}
      <Card className="mt-4 p-4 text-xs text-fg-2">
        <p>
          <b className="font-medium text-fg">Security:</b> tokens and target URLs can’t be viewed or changed from this page. Set them in the
          server’s environment (see <code className="rounded bg-surface-2 px-1">.env.example</code>) and restart. CI can trigger a sync with{' '}
          <code className="rounded bg-surface-2 px-1">POST /api/integrations/&lt;name&gt;/sync</code> using the Bearer token.
        </p>
      </Card>
    </>
  );
}

function StateBadge({ s }: { s: IntegrationStatus | undefined }) {
  if (!s || !s.configured)
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-2">
        <CircleDashed className="size-3" aria-hidden /> Not configured
      </span>
    );
  const map = {
    idle: { label: 'Connected', icon: CircleCheck, color: 'var(--st-passed)' },
    running: { label: 'Syncing…', icon: RefreshCw, color: 'var(--accent)' },
    error: { label: 'Error', icon: CircleX, color: 'var(--st-failed)' },
  } as const;
  const m = map[s.state];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-fg"
      style={{ background: `color-mix(in oklab, ${m.color} 11%, transparent)`, borderColor: `color-mix(in oklab, ${m.color} 28%, transparent)` }}
    >
      <m.icon className={cn('size-3', s.state === 'running' && 'animate-spin')} style={{ color: m.color }} aria-hidden />
      {m.label}
    </span>
  );
}

function IntegrationCard({ name, s }: { name: IntegrationName; s: IntegrationStatus | undefined }) {
  const info = INFO[name];
  const sync = useSyncIntegration();
  const running = s?.state === 'running' || sync.isPending;

  const trigger = () =>
    sync.mutate(name, {
      onSuccess: () => toast.info(`${info.title} sync started`),
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) toast.info('A sync is already running.');
        else toast.error(e.message);
      },
    });

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2">
          <info.icon className="size-4.5 text-fg-2" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-fg">{info.title}</h2>
            <StateBadge s={s} />
          </div>
          <p className="mt-0.5 text-xs text-fg-2">{info.blurb}</p>
        </div>
      </div>
      <div className="flex-1 px-4 py-3">
        {s?.configured ? (
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            <dt className="text-fg-3">Target</dt>
            <dd className="min-w-0 font-mono text-xs break-words text-fg">{s.target ?? '—'}</dd>
            <dt className="text-fg-3">Last sync</dt>
            <dd className="text-fg">
              {s.lastSyncAt ? (
                <Tooltip content={fmtDateTime(s.lastSyncAt)}>
                  <span>{fmtRelative(s.lastSyncAt)}</span>
                </Tooltip>
              ) : (
                'Never'
              )}
            </dd>
            <dt className="text-fg-3">Last success</dt>
            <dd className="text-fg">{s.lastSuccessAt ? fmtRelative(s.lastSuccessAt) : '—'}</dd>
            <dt className="text-fg-3">Schedule</dt>
            <dd className="text-fg">{s.intervalMinutes ? `Every ${s.intervalMinutes} min` : 'Manual only'}</dd>
            {s.lastStats ? (
              <>
                <dt className="text-fg-3">Last result</dt>
                <dd className="flex flex-wrap gap-x-3 text-xs text-fg-2 tabular">
                  <span>
                    <b className="font-semibold text-fg">{fmtNumber(s.lastStats.fetched)}</b> {name === 'github' ? 'PRs' : 'issues'} fetched
                  </span>
                  {name === 'jira' ? (
                    <span>
                      <b className="font-semibold text-fg">{fmtNumber(s.lastStats.created)}</b> created
                    </span>
                  ) : null}
                  <span>
                    <b className="font-semibold text-fg">{fmtNumber(s.lastStats.updated)}</b> updated
                  </span>
                  {name === 'github' ? (
                    <span>
                      <b className="font-semibold text-fg">{fmtNumber(s.lastStats.linked)}</b> links
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <div className="text-[13px] text-fg-2">
            <p>To enable, set these environment variables on the server and restart:</p>
            {info.required.map((set, i) => (
              <div key={i} className="mt-2">
                {i > 0 ? <p className="mb-1 text-[11px] text-fg-3">or (Server / Data Center)</p> : null}
                <div className="flex flex-wrap gap-1.5">
                  {set.map((v) => (
                    <code key={v} className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg">
                      {v}
                    </code>
                  ))}
                </div>
              </div>
            ))}
            <p className="mt-3 text-[11px] text-fg-3">Optional: {info.optional.join(', ')}</p>
          </div>
        )}
        {s?.lastError ? (
          <div role="alert" className="mt-3 flex gap-2 rounded-md border border-[color-mix(in_oklab,var(--st-failed)_30%,transparent)] bg-[color-mix(in_oklab,var(--st-failed)_7%,transparent)] px-3 py-2 text-xs text-fg">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-st-failed" aria-hidden />
            <span className="break-words">{s.lastError}</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end border-t border-border px-4 py-2.5">
        <Button variant={s?.configured ? 'primary' : 'secondary'} size="sm" onClick={trigger} disabled={!s?.configured || running} loading={running}>
          {running ? null : <RefreshCw />} {running ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>
    </Card>
  );
}
