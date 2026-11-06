import { useCallback, useSyncExternalStore } from 'react';
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
