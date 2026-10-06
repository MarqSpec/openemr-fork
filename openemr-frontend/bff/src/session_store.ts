import {randomBytes} from 'node:crypto';

/**
 * Server-side state keyed by an opaque id the browser holds in a cookie (FR-BFF-1, FR-BFF-2). Asynchronous so a
 * shared store (e.g. Redis, keyed by a hash of the id) can replace {@link MemoryStore} without touching callers.
 */
export interface ExpiringStore<T> {
  get(id: string): Promise<T | undefined>;
  set(id: string, value: T, ttlMs: number): Promise<void>;
  /** Read and delete in one step: a handshake is single-use. */
  take(id: string): Promise<T | undefined>;
  delete(id: string): Promise<void>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Oldest entries are evicted beyond this, so unauthenticated posts cannot grow memory without bound. */
  maxEntries: number;
  now: () => number;
}

/**
 * In-process store: **single instance only** — a second replica would not see this one's sessions, and a
 * restart signs everyone out. Swap for a shared store before scaling out.
 */
export class MemoryStore<T> implements ExpiringStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: MemoryStoreOptions) {}

  get size(): number {
    return this.entries.size;
  }

  get(id: string): Promise<T | undefined> {
    return Promise.resolve(this.live(id)?.value);
  }

  set(id: string, value: T, ttlMs: number): Promise<void> {
    this.sweep();
    this.entries.delete(id);
    this.entries.set(id, {value, expiresAt: this.options.now() + ttlMs});
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(oldest);
    }
    return Promise.resolve();
  }

  take(id: string): Promise<T | undefined> {
    const entry = this.live(id);
    this.entries.delete(id);
    return Promise.resolve(entry?.value);
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }

  private live(id: string): Entry<T> | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.options.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  /** Drops expired entries from the oldest end; insertion order approximates expiry order. */
  private sweep(): void {
    const now = this.options.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(id);
    }
  }
}

/** An opaque, unguessable id for a cookie: 256 random bits, base64url. */
export function newOpaqueId(): string {
  return randomBytes(32).toString('base64url');
}
