import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { readStorage, writeStorage } from './storage';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'ptd-theme';
const listeners = new Set<() => void>();

function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function getThemePref(): ThemePref {
  const v = readStorage(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export function setThemePref(pref: ThemePref) {
  writeStorage(KEY, pref === 'system' ? null : pref);
  apply(pref);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getResolved(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Theme preference + resolved theme, following the OS when pref = system. */
export function useTheme() {
  const pref = useSyncExternalStore(subscribe, getThemePref, () => 'system' as ThemePref);
  const resolved = useSyncExternalStore(subscribe, getResolved, () => 'light' as const);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => {
      if (getThemePref() === 'system') {
        apply('system');
        listeners.forEach((l) => l());
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const set = useCallback((p: ThemePref) => setThemePref(p), []);
  return { pref, resolved, setPref: set };
}

/** Reads CSS custom properties (for Recharts, which needs concrete colors). Re-reads on theme change. */
export function useCssVars<T extends string>(names: readonly T[]): Record<T, string> {
  const { resolved } = useTheme();
  void resolved; // dependency: recompute when theme flips
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<T, string>;
  for (const n of names) out[n] = style.getPropertyValue(`--${n}`).trim() || '#888';
  return out;
}

/**
 * Printing always uses the light theme: before the browser snapshots the page,
 * flip data-theme to light (so charts re-read light colors), restore afterwards.
 */
let printRestore: string | null = null;
export function installPrintTheme() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeprint', () => {
    printRestore = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'light');
    flushSync(() => listeners.forEach((l) => l()));
  });
  window.addEventListener('afterprint', () => {
    if (printRestore) document.documentElement.setAttribute('data-theme', printRestore);
    printRestore = null;
    listeners.forEach((l) => l());
  });
}
