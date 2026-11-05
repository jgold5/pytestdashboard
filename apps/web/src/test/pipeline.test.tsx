import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PIPELINE_FUNNEL, type PipelineCounts, type PullRequestRef } from '@ptd/shared';
import { PipelineFunnel, prsDrivingStage, stageHref } from '../components/pipeline';
import { PipelineStageBadge } from '../components/status';

const counts: PipelineCounts = {
  not_started: 13,
  in_progress: 3,
  pr_draft: 2,
  in_review: 4,
  ready_to_merge: 8,
  merged_awaiting_run: 3,
  automated: 84,
  not_automatable: 6,
};

describe('PipelineFunnel', () => {
  it('renders every funnel stage in order, with counts, linking to the filtered list', () => {
    render(
      <MemoryRouter>
        <PipelineFunnel counts={counts} />
      </MemoryRouter>,
    );
    const list = screen.getByRole('list', { name: 'Automation pipeline' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('data-stage'))).toEqual([...PIPELINE_FUNNEL]);
    const ready = screen.getByRole('link', { name: 'Ready to merge: 8 test cases' });
    expect(ready).toHaveAttribute('href', '/tests?pipelineStage=ready_to_merge');
    expect(screen.getByRole('link', { name: 'Merged (awaiting run): 3 test cases' })).toHaveAttribute(
      'href',
      stageHref('merged_awaiting_run'),
    );
    // not_automatable is not part of the funnel
    expect(screen.queryByRole('link', { name: /Not automatable/ })).toBeNull();
  });

  it('stage badge carries a text label', () => {
    render(<PipelineStageBadge stage="merged_awaiting_run" />);
    expect(screen.getByText('Merged (awaiting run)')).toBeInTheDocument();
  });
});

describe('prsDrivingStage', () => {
  const base: PullRequestRef = {
    repo: 'acme/t', number: 1, title: 'x', url: 'https://github.com/acme/t/pull/1', state: 'open', author: null,
    updatedAt: '2026-11-01T00:00:00.000Z', linkedBy: 'key_in_title', reviewState: 'approved', requestedReviewers: [],
    unresolvedThreads: 0, checks: 'passing', needsAttention: false, mergedAt: null, approvedAt: null, readyToMerge: true,
  };
  const ready = base;
  const review = { ...base, number: 2, readyToMerge: false, reviewState: 'review_required' as const };
  const draft = { ...base, number: 3, state: 'draft' as const, readyToMerge: false };
  const oldMerge = { ...base, number: 4, state: 'merged' as const, readyToMerge: false, mergedAt: '2026-10-01T00:00:00.000Z' };
  const newMerge = { ...base, number: 5, state: 'merged' as const, readyToMerge: false, mergedAt: '2026-10-20T00:00:00.000Z' };
  const all = [ready, review, draft, oldMerge, newMerge];
  it('picks the PRs behind each stage', () => {
    expect(prsDrivingStage('ready_to_merge', all).map((p) => p.number)).toEqual([1]);
    expect(prsDrivingStage('in_review', all).map((p) => p.number)).toEqual([2]);
    expect(prsDrivingStage('pr_draft', all).map((p) => p.number)).toEqual([3]);
    expect(prsDrivingStage('merged_awaiting_run', all).map((p) => p.number)).toEqual([5]);
    expect(prsDrivingStage('automated', all)).toEqual([]);
  });
});
