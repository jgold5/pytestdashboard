import ReactMarkdown, { type Components } from 'react-markdown';
import { safeHttpUrl } from '../lib/url';

/**
 * Safe markdown for user notes. react-markdown never renders raw HTML unless
 * rehype-raw is added (it isn't — and must not be). Links are restricted to
 * http(s) and always open in a new tab with noopener/noreferrer. Images are
 * not rendered (no tracking pixels / external requests under our CSP).
 */
const components: Components = {
  a: ({ href, children }) => {
    const safe = safeHttpUrl(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span>{alt ? `[image: ${alt}]` : '[image]'}</span>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-note text-[13px] leading-relaxed text-fg">
      <ReactMarkdown components={components} skipHtml urlTransform={(url) => safeHttpUrl(url) ?? ''}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
