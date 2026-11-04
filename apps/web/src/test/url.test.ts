import { describe, expect, it } from 'vitest';
import { safeHttpUrl, safeNextPath, toQueryString } from '../lib/url';

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

describe('safeNextPath (R2-05)', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/tests')).toBe('/tests');
    expect(safeNextPath('/tests?suite=Auth&page=2#x')).toBe('/tests?suite=Auth&page=2#x');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/runs/5')).toBe('/runs/5');
  });
  it('rejects everything from the redirect probe (redir3.cjs)', () => {
    const nexts = [
      '//evil.example/',
      '/\\evil.example/',
      '/\t/evil.example/',
      '/\n/evil.example/',
      '/\r/evil.example/',
      'https://evil.example/',
      'javascript:alert(1)',
      '/\\/evil.example',
      '/./\\evil.example',
      '/\x00/evil.example',
      '/\t\\evil.example',
      '/ /evil.example',
      '/\x0b/evil.example',
      '/\x0c/evil.example',
      '/ /evil.example',
      '',
      null,
      undefined,
    ];
    for (const n of nexts) expect(safeNextPath(n), JSON.stringify(n)).toBe('/');
  });
  it('confines encoded / lookalike variants to this origin', () => {
    for (const n of ['/%2F%2Fevil.example', '/%2f/evil.example', '/.//evil.example', '/%5C/evil.example', '/∕∕evil.example', '/／／evil.example', '/..//evil.example']) {
      const out = safeNextPath(n);
      expect(out.startsWith('/'), n).toBe(true);
      expect(out.startsWith('//'), n).toBe(false);
      expect(new URL(out, 'http://app.test').origin).toBe('http://app.test');
    }
  });
});
