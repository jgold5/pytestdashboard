import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const nf = new Intl.NumberFormat('en-US');
const compactNf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function fmtNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.abs(n) >= 10_000 ? compactNf.format(n) : nf.format(n);
}

/** 0..1 → "83%" (or "83.4%" with digits) */
export function fmtPct(rate: number | null | undefined, digits = 0): string {
  if (rate == null || Number.isNaN(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

/** Signed percentage-point delta, e.g. +3.2 pts */
export function fmtPts(delta: number | null | undefined, digits = 1): string {
  if (delta == null || Number.isNaN(delta)) return '—';
  const v = delta * 100;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${Math.abs(v).toFixed(digits)} pts`;
}

export function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = parseISO(iso);
  return isValid(d) ? d : null;
}

export function fmtDate(iso: string | null | undefined, pattern = 'MMM d, yyyy'): string {
  const d = toDate(iso);
  return d ? format(d, pattern) : '—';
}

export function fmtDateTime(iso: string | null | undefined): string {
  return fmtDate(iso, 'MMM d, yyyy HH:mm');
}

export function fmtRelative(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? `${formatDistanceToNowStrict(d)} ago` : '—';
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}
