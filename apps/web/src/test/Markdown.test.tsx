import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../components/Markdown';

describe('Markdown (notes)', () => {
  it('renders http(s) links in a new tab with noopener/noreferrer', () => {
    render(<Markdown>{'See [ticket](https://jira.example.com/browse/QA-1)'}</Markdown>);
    const a = screen.getByRole('link', { name: 'ticket' });
    expect(a).toHaveAttribute('href', 'https://jira.example.com/browse/QA-1');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never renders javascript: / data: links', () => {
    const { container } = render(<Markdown>{'[x](javascript:alert(1)) [y](data:text/html,hi)'}</Markdown>);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('does not render raw HTML', () => {
    const { container } = render(<Markdown>{'<img src=x onerror=alert(1)><script>alert(1)</script>**bold**'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('does not load images from markdown', () => {
    const { container } = render(<Markdown>{'![pixel](https://tracker.example.com/p.gif)'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[image: pixel]');
  });
});
