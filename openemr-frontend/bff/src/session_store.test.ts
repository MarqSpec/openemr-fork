import {describe, expect, it} from 'vitest';
import {MemoryStore, newOpaqueId} from './session_store.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('given the in-memory server-side store (single instance)', () => {
  it('when an entry is stored, then it is read back by its id until its time-to-live ends', async () => {
    const time = clock();
    const store = new MemoryStore<{value: string}>({
      maxEntries: 10,
      now: time.now,
    });

    await store.set('id-1', {value: 'a'}, 1000);
    time.advance(999);
    expect(await store.get('id-1')).toEqual({value: 'a'});

    time.advance(1);
    expect(await store.get('id-1')).toBeUndefined();
  });

  it('when an entry is taken, then it is returned once and is gone afterwards (single use)', async () => {
    const store = new MemoryStore<string>({maxEntries: 10, now: clock().now});
    await store.set('id-1', 'handshake', 1000);

    expect(await store.take('id-1')).toBe('handshake');
    expect(await store.take('id-1')).toBeUndefined();
    expect(await store.get('id-1')).toBeUndefined();
  });

  it('when an expired entry is taken, then nothing is returned', async () => {
    const time = clock();
    const store = new MemoryStore<string>({maxEntries: 10, now: time.now});
    await store.set('id-1', 'handshake', 1000);
    time.advance(1000);

    expect(await store.take('id-1')).toBeUndefined();
  });

  it('when an entry is deleted, then it cannot be read', async () => {
    const store = new MemoryStore<string>({maxEntries: 10, now: clock().now});
    await store.set('id-1', 'session', 1000);
    await store.delete('id-1');

    expect(await store.get('id-1')).toBeUndefined();
  });

  it('when the store is full, then the oldest entry is evicted so unauthenticated posts cannot grow memory without bound', async () => {
    const store = new MemoryStore<string>({maxEntries: 2, now: clock().now});
    await store.set('a', '1', 1000);
    await store.set('b', '2', 1000);
    await store.set('c', '3', 1000);

    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBe('2');
    expect(await store.get('c')).toBe('3');
    expect(store.size).toBe(2);
  });

  it('when entries expire, then a later write sweeps them out', async () => {
    const time = clock();
    const store = new MemoryStore<string>({maxEntries: 10, now: time.now});
    await store.set('a', '1', 100);
    await store.set('b', '2', 100);
    time.advance(100);
    await store.set('c', '3', 100);

    expect(store.size).toBe(1);
  });
});

describe('given the opaque ids the browser receives', () => {
  it('when minted, then each carries at least 128 bits of randomness, base64url, and never repeats', () => {
    const ids = new Set(Array.from({length: 200}, () => newOpaqueId()));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      // 6 bits per base64url character: 22 characters is 132 bits.
      expect(id.length * 6).toBeGreaterThanOrEqual(128);
    }
  });
});
