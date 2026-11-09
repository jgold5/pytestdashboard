import { describe, expect, it } from 'vitest';
import { scopeSelection } from '../components/ScopeButton';

// the server's answer for the previous pick: what the picker must not wait for
const d = {
  routeBranches: ['main', 'core', 'dev'],
  defaultBranch: 'main',
  testBranches: ['main', 'develop', 'core'],
  triggerRepo: { branch: 'main' },
  testRepo: { branch: 'main' },
};

describe('the scope picker shows a pick at once', () => {
  it('a routes branch picked shows before the server answers', () => {
    expect(scopeSelection({ branch: 'dev', tests: null }, d).routes).toBe('dev');
  });
  it('a tests branch picked shows before the server answers', () => {
    expect(scopeSelection({ branch: null, tests: 'develop' }, d).tests).toBe('develop');
  });
  it('no tests branch picked: the one named like the routes branch, else the default', () => {
    expect(scopeSelection({ branch: 'core', tests: null }, d).tests).toBe('core');
    expect(scopeSelection({ branch: 'dev', tests: null }, d).tests).toBe('main');
  });
  it('a routes branch that has no scan falls back to the default, like the server', () => {
    expect(scopeSelection({ branch: 'gone', tests: null }, d).routes).toBe('main');
  });
  it('a tests branch the list does not show (from a link): the server\'s answer', () => {
    expect(scopeSelection({ branch: null, tests: 'feature/x' }, { ...d, testRepo: { branch: 'feature/x' } }).tests).toBe('feature/x');
  });
});
