import { randomUUID } from 'node:crypto';
import type { ParsedSheet } from './parse.js';

export interface StoredUpload {
  fileName: string;
  sheets: ParsedSheet[];
  createdAt: number;
}

/** In-memory parsed uploads: TTL 1h, LRU-evicted beyond `max` entries. */
export class UploadStore {
  private readonly map = new Map<string, StoredUpload>();
  constructor(
    private readonly max = 20,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  put(fileName: string, sheets: ParsedSheet[]): string {
    this.sweep();
    const id = randomUUID();
    this.map.set(id, { fileName, sheets, createdAt: this.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return id;
  }

  get(id: string): StoredUpload | undefined {
    const v = this.map.get(id);
    if (!v) return undefined;
    if (this.now() - v.createdAt > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.map) if (t - v.createdAt > this.ttlMs) this.map.delete(k);
  }
}
