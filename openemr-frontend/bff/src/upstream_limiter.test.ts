import {describe, expect, it} from 'vitest';
import {LimiterBusyError, UpstreamLimiter} from './upstream_limiter.js';

// reference: REQUIREMENTS.md BUG-28 — cap concurrent FHIR calls in the token handler; REQUIREMENTS.md FR-BFF-3

/** Settles pending promise callbacks so a grant made on release is visible. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

describe('given a global cap of 2 and a per-session cap of 2', () => {
  it('when three calls ask for a slot, then two run and the third waits until one releases', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 2,
      maxPerKey: 2,
      maxQueued: 10,
    });
    const first = await limiter.acquire('a', neverAborted());
    await limiter.acquire('b', neverAborted());
    let thirdGranted = false;
    const third = limiter.acquire('c', neverAborted()).then(release => {
      thirdGranted = true;
      return release;
    });
    await settle();

    expect(limiter.active).toBe(2);
    expect(thirdGranted).toBe(false);

    first();
    await third;

    expect(thirdGranted).toBe(true);
    expect(limiter.active).toBe(2);
  });

  it('when a slot is released twice, then it frees only one slot', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 2,
      maxPerKey: 2,
      maxQueued: 10,
    });
    const release = await limiter.acquire('a', neverAborted());
    await limiter.acquire('a', neverAborted());

    release();
    release();

    expect(limiter.active).toBe(1);
  });
});

describe('given a global cap of 3 and a per-session cap of 2 (fairness)', () => {
  it('when one session queues behind its own cap, then another session’s call is not held behind it', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 3,
      maxPerKey: 2,
      maxQueued: 10,
    });
    await limiter.acquire('busy', neverAborted());
    await limiter.acquire('busy', neverAborted());
    let busyThirdGranted = false;
    void limiter.acquire('busy', neverAborted()).then(() => {
      busyThirdGranted = true;
    });
    await settle();

    const other = await limiter.acquire('other', neverAborted());

    expect(typeof other).toBe('function');
    expect(busyThirdGranted).toBe(false);
    expect(limiter.active).toBe(3);
  });
});

describe('given a full limiter', () => {
  it('when the queue is full too, then a further call is refused at once as busy', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 1,
      maxPerKey: 1,
      maxQueued: 1,
    });
    await limiter.acquire('a', neverAborted());
    void limiter.acquire('b', neverAborted());

    await expect(limiter.acquire('c', neverAborted())).rejects.toBeInstanceOf(
      LimiterBusyError,
    );
  });

  it('when a waiting call is aborted (its timeout), then it rejects, leaves the queue and never takes a slot', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 1,
      maxPerKey: 1,
      maxQueued: 5,
    });
    const release = await limiter.acquire('a', neverAborted());
    const controller = new AbortController();
    const waiting = limiter.acquire('b', controller.signal);

    controller.abort(new Error('timed out'));

    await expect(waiting).rejects.toThrow('timed out');
    expect(limiter.queued).toBe(0);
    release();
    expect(limiter.active).toBe(0);
  });

  it('when a call arrives already aborted, then it rejects without taking a slot', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 1,
      maxPerKey: 1,
      maxQueued: 5,
    });

    await expect(
      limiter.acquire('a', AbortSignal.abort(new Error('gone'))),
    ).rejects.toThrow('gone');
    expect(limiter.active).toBe(0);
  });
});

describe('given a per-session queue cap (fairness of the queue)', () => {
  it('when one session has filled its share of the queue, then its next call is refused as busy while another session still queues', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 1,
      maxPerKey: 1,
      maxQueued: 10,
      maxQueuedPerKey: 2,
    });
    await limiter.acquire('busy', neverAborted());
    void limiter.acquire('busy', neverAborted());
    void limiter.acquire('busy', neverAborted());

    await expect(
      limiter.acquire('busy', neverAborted()),
    ).rejects.toBeInstanceOf(LimiterBusyError);
    void limiter.acquire('other', neverAborted());
    expect(limiter.queued).toBe(3);
  });

  it('when a queued call is granted or aborted, then it no longer counts against its session’s share', async () => {
    const limiter = new UpstreamLimiter({
      maxConcurrent: 1,
      maxPerKey: 1,
      maxQueued: 10,
      maxQueuedPerKey: 1,
    });
    const release = await limiter.acquire('a', neverAborted());
    const controller = new AbortController();
    const aborted = limiter.acquire('a', controller.signal);
    controller.abort(new Error('timed out'));
    await expect(aborted).rejects.toThrow('timed out');

    const queued = limiter.acquire('a', neverAborted());
    release();
    const next = await queued;

    expect(typeof next).toBe('function');
    void limiter.acquire('a', neverAborted());
    expect(limiter.queued).toBe(1);
  });
});
