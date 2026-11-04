import { describe, expect, it } from 'vitest';
import { safeHttpUrl, toQueryString } from '../lib/url';

describe('safeHttpUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(safeHttpUrl('https://acme.atlassian.net/browse/QA-1')).toBe('https://acme.atlassian.net/browse/QA-1');
    expect(safeHttpUrl('  http://x.test/a ')).toBe('http://x.test/a');
  });
  it('rejects dangerous or relative schemes', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'vbscript:x', '//evil.com', '/relative', 'ftp://x', '', null, undefined]) {
      expect(safeHttpUrl(bad as string)).toBeNull();
    }
  });
});

describe('toQueryString', () => {
  it('skips empty values and serializes the rest', () => {
    expect(toQueryString({ a: 1, b: '', c: undefined, d: null, e: true, f: 'x y' })).toBe('?a=1&e=true&f=x+y');
    expect(toQueryString({})).toBe('');
  });
});
