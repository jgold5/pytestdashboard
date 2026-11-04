import { useCallback, useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from './storage';

/** Author name for notes. Convenience only (not identity) — stored in localStorage. */
const KEY = 'ptd-author';
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getAuthor(): string {
  return readStorage(KEY) ?? '';
}

export function setAuthor(name: string) {
  writeStorage(KEY, name.trim() || null);
  listeners.forEach((l) => l());
}

export function useAuthor(): [string, (name: string) => void] {
  const author = useSyncExternalStore(subscribe, getAuthor, () => '');
  const set = useCallback((n: string) => setAuthor(n), []);
  return [author, set];
}
