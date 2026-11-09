import { useCallback, useSyncExternalStore } from 'react';
import { TriggerKind } from '@ptd/shared';
import { readStorage, writeStorage } from './storage';

/**
 * What the Overview and Report count: a branch of the trigger repo (null = the default,
 * main/master/develop) and a folder in it (null = the whole branch). Kept in this browser so
 * they stay picked until changed.
 */
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function useStored(key: string): [string | null, (v: string | null) => void] {
  const value = useSyncExternalStore(subscribe, () => readStorage(key), () => null);
  const set = useCallback(
    (v: string | null) => {
      writeStorage(key, v);
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}

export const useScopeBranch = () => useStored('ptd-scope-branch');
export const useScopeFolder = () => useStored('ptd-scope-folder');
/** The test repo branch whose merged tests count (plus the PRs into it); null = the same name as the routes branch. */
export const useScopeTests = () => useStored('ptd-scope-tests');
/**
 * The kinds of trigger counted, comma-separated (`file,schedule`); null = every kind. Unknown
 * kinds (from an older version) are dropped so the server never rejects the query.
 */
export function useScopeKinds(): [string | null, (v: string | null) => void] {
  const [raw, set] = useStored('ptd-scope-kinds');
  return [cleanKinds(raw), set];
}

export function cleanKinds(raw: string | null | undefined): string | null {
  const known = (raw ?? '').split(',').filter((k): k is TriggerKind => (TriggerKind.options as string[]).includes(k));
  return known.length ? [...new Set(known)].join(',') : null;
}
