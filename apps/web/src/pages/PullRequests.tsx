import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Fragment, type ReactNode } from 'react';
import { GitBranch, GitPullRequest, GitPullRequestArrow, Plug, TriangleAlert } from 'lucide-react';
import type { PullRequest } from '@ptd/shared';
import { usePullRequests, type PullRequestQueryInput } from '../api/hooks';
import { cn, fmtDateTime, fmtRelative } from '../lib/utils';
import { Card } from '../components/ui/card';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { ExternalLink, PageHeader } from '../components/ui/misc';
import { SkeletonRows } from '../components/ui/skeleton';
import { linkButton } from '../components/ui/link-button';
import { Tooltip } from '../components/ui/tooltip';
import { Select } from '../components/ui/select';
import {
  ChecksBadge,
  PipelineStageBadge,
  PrStateBadge,
  ReviewBadge,
  ThreadsCount,
} from '../components/status';

const FILTERS = [
  { key: 'open', label: 'All open', q: {} },
  { key: 'ready', label: 'Ready to merge', q: { readyToMerge: true } },
  { key: 'attention', label: 'Needs attention', q: { needsAttention: true } },
  { key: 'review_required', label: 'Review required', q: { reviewState: 'review_required' } },
  { key: 'changes_requested', label: 'Changes requested', q: { reviewState: 'changes_requested' } },
  { key: 'approved', label: 'Approved', q: { reviewState: 'approved' } },
  { key: 'draft', label: 'Draft', q: { state: 'draft' } },
  { key: 'merged', label: 'Recently merged', q: { state: 'merged' } },
] as const satisfies readonly { key: string; label: string; q: PullRequestQueryInput }[];

type FilterKey = (typeof FILTERS)[number]['key'];

function isOpen(p: PullRequest) {
  return p.state === 'open' || p.state === 'draft';
}

export default function PullRequestsPage() {
  const [params, setParams] = useSearchParams();
  const filterKey = (FILTERS.find((f) => f.key === params.get('filter'))?.key ??
    'open') as FilterKey;
  const filter = FILTERS.find((f) => f.key === filterKey)!;
  const repo = params.get('repo') || undefined;
  const author = params.get('author') || undefined;
  // Default: only automation PRs (linked to a test case). ?all=1 shows every synced PR.
  const showAll = params.get('all') === '1';
  const prs = usePullRequests({ ...filter.q, repo, author, linkedOnly: !showAll });
  // Options come from the unfiltered list so every repo/author stays selectable.
  const all = usePullRequests({ linkedOnly: false });
  const repos = useMemo(() => [...new Set((all.data ?? []).map((p) => p.repo))].sort(), [all.data]);
  const authors = useMemo(
    () =>
      [...new Set((all.data ?? []).map((p) => p.author).filter((a): a is string => !!a))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [all.data],
  );
  const unlinkedCount = (all.data ?? []).filter((p) => p.testCases.length === 0 && (filterKey !== 'open' || isOpen(p))).length;
  const setParam = (key: 'repo' | 'author' | 'all', v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(key, v);
        else n.delete(key);
        return n;
      },
      { replace: true },
    );
  // "All open" excludes merged/closed client-side (the API returns recent merged PRs too).
  const items = (prs.data ?? []).filter((p) => (filterKey === 'open' ? isOpen(p) : true));
  // Default sort: needs attention first, then most recently updated. In the default
  // view, PRs that are ready to merge ("done, awaiting merge") get their own section on top.
  const sorted = [...items].sort(
    (a, b) =>
      Number(b.needsAttention) - Number(a.needsAttention) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const sectioned = filterKey === 'open' && sorted.some((p) => p.readyToMerge);
  const sections: Array<{ key: string; title: ReactNode; rows: PullRequest[] }> = sectioned
    ? [
        {
          key: 'ready',
          title: (
            <>
              <GitPullRequestArrow className="size-3.5 text-st-passed" aria-hidden /> Ready to merge
              · {sorted.filter((p) => p.readyToMerge).length} — approved, checks green, no open
              threads
            </>
          ),
          rows: sorted.filter((p) => p.readyToMerge),
        },
        {
          key: 'rest',
          title: <>Other open PRs · {sorted.filter((p) => !p.readyToMerge).length}</>,
          rows: sorted.filter((p) => !p.readyToMerge),
        },
      ]
    : [{ key: 'all', title: null, rows: sorted }];

  return (
    <>
      <PageHeader
        title="Pull requests"
        description="Automation PRs linked to test cases — what’s waiting on review, and what needs the author’s attention."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filter pull requests" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const active = f.key === filterKey;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() =>
                  setParams(
                    (p) => {
                      const n = new URLSearchParams(p);
                      if (f.key === 'open') n.delete('filter');
                      else n.set('filter', f.key);
                      return n;
                    },
                    { replace: true },
                  )
                }
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  active
                    ? 'border-accent/50 bg-accent-soft font-medium text-fg'
                    : 'border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
                )}
              >
                {f.key === 'attention' ? (
                  <TriangleAlert className="size-3.5 text-st-failed" aria-hidden />
                ) : null}
                {f.key === 'ready' ? (
                  <GitPullRequestArrow className="size-3.5 text-st-passed" aria-hidden />
                ) : null}
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Select
            size="sm"
            ariaLabel="Which pull requests"
            value={showAll ? 'all' : 'linked'}
            onValueChange={(v) => setParam('all', v === 'all' ? '1' : null)}
            options={[
              { value: 'linked', label: 'Linked to tests' },
              { value: 'all', label: 'All synced PRs' },
            ]}
            className="w-40"
          />
          <Select
            size="sm"
            ariaLabel="Repository"
            value={repo ?? null}
            onValueChange={(v) => setParam('repo', v)}
            options={(repo && !repos.includes(repo) ? [...repos, repo] : repos).map((r) => ({
              value: r,
              label: r,
            }))}
            allowNone
            noneLabel="All repos"
            className="w-44"
          />
          <Select
            size="sm"
            ariaLabel="Author"
            value={author ?? null}
            onValueChange={(v) => setParam('author', v)}
            options={(author && !authors.includes(author) ? [...authors, author] : authors).map(
              (a) => ({ value: a, label: a }),
            )}
            allowNone
            noneLabel="All authors"
            className="w-40"
          />
        </div>
      </div>

      <Card className={cn('overflow-hidden', prs.isPlaceholderData && 'opacity-70')}>
        {prs.isError ? (
          <ErrorState error={prs.error} onRetry={() => void prs.refetch()} />
        ) : prs.isPending ? (
          <SkeletonRows rows={6} />
        ) : sorted.length === 0 ? (
          !showAll && unlinkedCount > 0 ? (
            <EmptyState
              icon={<GitPullRequest />}
              title={`${unlinkedCount} synced ${unlinkedCount === 1 ? 'PR is' : 'PRs are'} not linked to a test case`}
              actions={
                <button type="button" className={linkButton('outline')} onClick={() => setParam('all', '1')}>
                  Show all synced PRs
                </button>
              }
            >
              A PR is linked when its title, description or branch names a test case (its key or Jira key), or it changes a test file
              (GITHUB_TEST_PATH_GLOBS) with a test the dashboard knows from an Allure import.
            </EmptyState>
          ) : filterKey === 'open' && !repo && !author ? (
            <EmptyState
              icon={<GitPullRequest />}
              title="No open automation PRs"
              actions={
                <Link to="/integrations" className={linkButton('outline')}>
                  <Plug /> Integrations
                </Link>
              }
            >
              PRs appear here once the GitHub integration is configured and a PR mentions a test
              case key or adds its test.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<GitPullRequest />}
              title={`No PRs: ${filter.label.toLowerCase()}${repo ? ` in ${repo}` : ''}${author ? ` by ${author}` : ''}`}
            />
          )
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-2/60 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 font-medium">Pull request</th>
                    <th className="px-2 py-2 font-medium">State</th>
                    <th className="px-2 py-2 font-medium">Review</th>
                    <th className="px-2 py-2 font-medium">Reviewers</th>
                    <th className="px-2 py-2 font-medium" title="Unresolved review threads">
                      Threads
                    </th>
                    <th className="px-2 py-2 font-medium">Checks</th>
                    <th className="px-2 py-2 font-medium">Linked cases</th>
                    <th className="px-2 py-2 pr-4 text-right font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((sec) => (
                    <Fragment key={sec.key}>
                      {sec.title ? (
                        <tr className="border-b border-border bg-surface-2/40">
                          <th
                            colSpan={8}
                            scope="rowgroup"
                            className="px-4 py-1.5 text-left text-xs font-medium text-fg-2"
                          >
                            <span className="inline-flex items-center gap-1.5">{sec.title}</span>
                          </th>
                        </tr>
                      ) : null}
                      {sec.rows.map((p) => (
                        <tr
                          key={p.id}
                          className={cn(
                            'border-b border-border align-top last:border-0 hover:bg-surface-2/50',
                            p.needsAttention &&
                              'bg-[color-mix(in_oklab,var(--st-failed)_4%,transparent)]',
                          )}
                        >
                          <td className="max-w-[360px] px-4 py-2.5">
                            <PrTitle p={p} />
                          </td>
                          <td className="px-2 py-2.5">
                            {p.readyToMerge ? (
                              <PipelineStageBadge stage="ready_to_merge" />
                            ) : (
                              <PrStateBadge state={p.state} />
                            )}
                          </td>
                          <td className="px-2 py-2.5">
                            {isOpen(p) ? (
                              <ReviewBadge state={p.reviewState} />
                            ) : (
                              <span className="text-fg-3">—</span>
                            )}
                          </td>
                          <td className="max-w-36 px-2 py-2.5 text-xs text-fg-2">
                            {p.requestedReviewers.length ? (
                              <span className="line-clamp-2">
                                {p.requestedReviewers.join(', ')}
                              </span>
                            ) : (
                              <span className="text-fg-3">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2.5">
                            <ThreadsCount count={p.unresolvedThreads} />
                          </td>
                          <td className="px-2 py-2.5">
                            {isOpen(p) ? (
                              <ChecksBadge checks={p.checks} />
                            ) : (
                              <span className="text-fg-3">—</span>
                            )}
                          </td>
                          <td className="max-w-56 px-2 py-2.5">
                            <CaseChips p={p} />
                          </td>
                          <td className="px-2 py-2.5 pr-4 text-right text-xs whitespace-nowrap text-fg-2">
                            <Tooltip content={fmtDateTime(p.updatedAt)}>
                              <span>{fmtRelative(p.updatedAt)}</span>
                            </Tooltip>
                            {p.readyToMerge && p.approvedAt ? (
                              <div className="text-[11px] text-fg-3">
                                approved {fmtRelative(p.approvedAt)}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile / tablet cards */}
            <ul className="divide-y divide-border lg:hidden">
              {sections.flatMap((sec) => [
                sec.title ? (
                  <li
                    key={`h-${sec.key}`}
                    className="flex items-center gap-1.5 bg-surface-2/40 px-4 py-1.5 text-xs font-medium text-fg-2"
                  >
                    {sec.title}
                  </li>
                ) : null,
                ...sec.rows.map((p) => (
                  <li
                    key={p.id}
                    className={cn(
                      'space-y-2 px-4 py-3',
                      p.needsAttention &&
                        'bg-[color-mix(in_oklab,var(--st-failed)_4%,transparent)]',
                    )}
                  >
                    <PrTitle p={p} />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p.readyToMerge ? (
                        <PipelineStageBadge stage="ready_to_merge" />
                      ) : (
                        <PrStateBadge state={p.state} />
                      )}
                      {isOpen(p) ? (
                        <>
                          <ReviewBadge state={p.reviewState} />
                          <ChecksBadge checks={p.checks} />
                        </>
                      ) : null}
                      <ThreadsCount count={p.unresolvedThreads} />
                      <span className="ml-auto text-[11px] text-fg-3">
                        {fmtRelative(p.updatedAt)}
                      </span>
                    </div>
                    {p.requestedReviewers.length ? (
                      <div className="text-xs text-fg-2">
                        Waiting on {p.requestedReviewers.join(', ')}
                      </div>
                    ) : null}
                    <CaseChips p={p} />
                  </li>
                )),
              ])}
            </ul>
          </>
        )}
      </Card>
    </>
  );
}

function PrTitle({ p }: { p: PullRequest }) {
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1.5">
        {p.needsAttention ? (
          <Tooltip content="Needs attention: changes requested, unresolved threads or failing checks">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0 text-st-failed"
              aria-label="Needs attention"
            />
          </Tooltip>
        ) : null}
        <ExternalLink
          href={p.url}
          showIcon={false}
          className="font-medium text-fg"
          fallback={<span className="font-medium text-fg">{p.title}</span>}
        >
          <span className="line-clamp-2">{p.title}</span>
        </ExternalLink>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-fg-3">
        <span>
          {p.repo}#{p.number}
        </span>
        {p.author ? <span className="font-sans">by {p.author}</span> : null}
        {p.headBranch ? (
          <span className="inline-flex max-w-48 items-center gap-0.5 truncate">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{p.headBranch}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CaseChips({ p }: { p: PullRequest }) {
  const shown = p.testCases.slice(0, 4);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <Tooltip key={t.id} content={t.title}>
          <Link
            to={`/tests/${t.id}`}
            className="inline-flex max-w-40 items-center truncate rounded-md border border-border bg-surface-2 px-1.5 py-px font-mono text-[11px] text-fg-2 hover:border-border-strong hover:text-fg"
          >
            {t.key}
          </Link>
        </Tooltip>
      ))}
      {p.testCases.length > shown.length ? (
        <span className="text-[11px] text-fg-3">+{p.testCases.length - shown.length}</span>
      ) : null}
    </div>
  );
}
