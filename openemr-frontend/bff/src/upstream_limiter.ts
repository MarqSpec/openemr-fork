/** The queue is full: the caller answers 503 rather than wait. */
export class LimiterBusyError extends Error {
  constructor() {
    super('upstream queue full');
    this.name = 'LimiterBusyError';
  }
}

export interface LimiterOptions {
  maxConcurrent: number;
  /** Slots one key (a session) may hold at once. */
  maxPerKey: number;
  maxQueued: number;
  /** Waiters one key may have queued, so one session cannot fill the whole queue. Default: `maxQueued`. */
  maxQueuedPerKey?: number;
}

interface Waiter {
  key: string;
  grant: () => void;
}

/**
 * Caps concurrent upstream calls globally and per key (BUG-28). Waiters are served first-come, except that one
 * over its key's share never blocks a later waiter under its own — so one session's fan-out cannot starve another.
 */
export class UpstreamLimiter {
  private total = 0;
  private readonly byKey = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private readonly queuedByKey = new Map<string, number>();

  constructor(private readonly options: LimiterOptions) {}

  get active(): number {
    return this.total;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Resolves with a release function once a slot is held; rejects on abort or when the queue is full. */
  acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(toError(signal.reason));
    if (this.canRun(key)) return Promise.resolve(this.take(key));
    const queuedForKey = this.queuedByKey.get(key) ?? 0;
    if (
      this.waiters.length >= this.options.maxQueued ||
      queuedForKey >= (this.options.maxQueuedPerKey ?? this.options.maxQueued)
    ) {
      return Promise.reject(new LimiterBusyError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          this.dequeued(key);
        }
        reject(toError(signal.reason));
      };
      const waiter: Waiter = {
        key,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          this.dequeued(key);
          resolve(this.take(key));
        },
      };
      signal.addEventListener('abort', onAbort, {once: true});
      this.waiters.push(waiter);
      this.queuedByKey.set(key, queuedForKey + 1);
    });
  }

  private dequeued(key: string): void {
    const left = (this.queuedByKey.get(key) ?? 1) - 1;
    if (left === 0) this.queuedByKey.delete(key);
    else this.queuedByKey.set(key, left);
  }

  private canRun(key: string): boolean {
    return (
      this.total < this.options.maxConcurrent &&
      (this.byKey.get(key) ?? 0) < this.options.maxPerKey
    );
  }

  private take(key: string): () => void {
    this.total += 1;
    this.byKey.set(key, (this.byKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const held = (this.byKey.get(key) ?? 1) - 1;
      if (held === 0) this.byKey.delete(key);
      else this.byKey.set(key, held);
      this.pump();
    };
  }

  private pump(): void {
    for (let i = 0; i < this.waiters.length;) {
      if (this.total >= this.options.maxConcurrent) return;
      const waiter = this.waiters[i];
      if (waiter !== undefined && this.canRun(waiter.key)) {
        this.waiters.splice(i, 1);
        waiter.grant();
      } else {
        i += 1;
      }
    }
  }
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('aborted');
}
