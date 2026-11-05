import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { ParsedSheet } from './parse.js';

export interface StoredUpload {
  fileName: string;
  sheets: ParsedSheet[];
  createdAt: number;
  /** Estimated retained heap bytes. */
  bytes: number;
}

/** Rough V8 retained size: 2 bytes/char + per-string and per-array overhead. */
export function estimateSheetsBytes(sheets: readonly ParsedSheet[]): number {
  let n = 0;
  for (const s of sheets) {
    for (const h of s.headers) n += 32 + h.length * 2;
    for (const r of s.rows) {
      n += 64 + r.cells.length * 8;
      for (const c of r.cells) n += c.length === 0 ? 0 : 32 + c.length * 2;
    }
  }
  return n;
}

/**
 * In-memory parsed uploads: TTL 1h, LRU-evicted beyond `max` entries or beyond
 * a total byte budget (default 200 MB).
 */
export class UploadStore {
  private readonly map = new Map<string, StoredUpload>();
  private totalBytes = 0;
  constructor(
    private readonly max = 20,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 200 * 1024 * 1024,
  ) {}

  get bytes(): number {
    return this.totalBytes;
  }

  put(fileName: string, sheets: ParsedSheet[]): string {
    this.sweep();
    const bytes = estimateSheetsBytes(sheets);
    if (bytes > this.maxBytes) throw new AppError(413, 'spreadsheet_too_large', 'Spreadsheet is too large to preview');
    while (this.map.size > 0 && (this.map.size >= this.max || this.totalBytes + bytes > this.maxBytes)) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    const id = randomUUID();
    this.map.set(id, { fileName, sheets, createdAt: this.now(), bytes });
    this.totalBytes += bytes;
    return id;
  }

  get(id: string): StoredUpload | undefined {
    const v = this.map.get(id);
    if (!v) return undefined;
    if (this.now() - v.createdAt > this.ttlMs) {
      this.delete(id);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }

  delete(id: string): void {
    const v = this.map.get(id);
    if (!v) return;
    this.totalBytes -= v.bytes;
    this.map.delete(id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.map) if (t - v.createdAt > this.ttlMs) this.delete(k);
  }
}
