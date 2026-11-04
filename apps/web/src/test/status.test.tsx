import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AutomationBadge, InPrBadge, ResultBadge, TriageBadge } from '../components/status';
import { TooltipProvider } from '../components/ui/tooltip';
import type { PullRequestRef } from '@ptd/shared';

describe('status badges carry a text label (never color alone)', () => {
  it('renders labels', () => {
    render(
      <>
        <ResultBadge status="broken" />
        <AutomationBadge status="in_progress" />
        <TriageBadge triage="product_bug" />
      </>,
    );
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Product bug')).toBeInTheDocument();
  });

  it('shows the In PR badge only for open/draft PRs', () => {
    const pr: PullRequestRef = {
      repo: 'acme/t', number: 1, title: 'x', url: 'https://github.com/acme/t/pull/1', state: 'merged', author: null,
      updatedAt: new Date().toISOString(), linkedBy: 'key_in_title', reviewState: 'approved', requestedReviewers: [],
      unresolvedThreads: 0, checks: 'passing', needsAttention: false,
    };
    const { rerender, container } = render(<TooltipProvider><InPrBadge prs={[pr]} /></TooltipProvider>);
    expect(container.textContent).toBe('');
    rerender(<TooltipProvider><InPrBadge prs={[{ ...pr, state: 'open', needsAttention: true }]} /></TooltipProvider>);
    expect(screen.getByLabelText(/In 1 open pull request, needs attention/)).toBeInTheDocument();
  });
});
