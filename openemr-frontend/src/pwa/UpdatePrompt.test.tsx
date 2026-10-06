import {act, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {UpdatePrompt} from './UpdatePrompt';
import {
  SERVICE_WORKER_URL,
  SKIP_WAITING_MESSAGE,
  type RegistrationHandle,
  type WorkerContainer,
  type WorkerHandle,
} from './update';

// reference: REQUIREMENTS.md FR-PWA-3 · REQUIREMENTS.md W-8

class FakeWorker implements WorkerHandle {
  state = 'installing';
  readonly messages: unknown[] = [];
  private readonly listeners: (() => void)[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.push(listener);
  }

  become(state: string): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeRegistration implements RegistrationHandle {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  readonly update = vi.fn(() => Promise.resolve());
  private readonly listeners: (() => void)[] = [];

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.push(listener);
  }

  /** A new version was found: it starts installing. */
  found(worker: FakeWorker): void {
    this.installing = worker;
    for (const listener of this.listeners) listener();
  }
}

class FakeContainer implements WorkerContainer {
  readonly registration = new FakeRegistration();
  readonly register = vi.fn(() => Promise.resolve(this.registration));
  private readonly listeners = new Set<() => void>();

  constructor(public controller: object | null) {}

  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  changeController(): void {
    this.controller = {};
    for (const listener of this.listeners) listener();
  }
}

const prompt = () => screen.queryByRole('status');

describe('given the app running a service worker', () => {
  it('when it starts, then it registers /sw.js for the whole origin', async () => {
    const container = new FakeContainer({});
    render(<UpdatePrompt container={container} reload={vi.fn()} />);

    await act(() => Promise.resolve());

    expect(container.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
      scope: '/',
    });
  });

  it('when a worker installs for the first time, then nothing is offered (there is nothing to update from)', async () => {
    const container = new FakeContainer(null);
    render(<UpdatePrompt container={container} reload={vi.fn()} />);
    await act(() => Promise.resolve());

    const worker = new FakeWorker();
    act(() => {
      container.registration.found(worker);
      worker.become('installed');
    });

    expect(prompt()).not.toBeInTheDocument();
  });

  it('when a new version finishes installing mid-session, then "Update available" is offered and the new worker is left waiting (FR-PWA-3)', async () => {
    const container = new FakeContainer({});
    const reload = vi.fn();
    render(<UpdatePrompt container={container} reload={reload} />);
    await act(() => Promise.resolve());

    const worker = new FakeWorker();
    act(() => {
      container.registration.found(worker);
      worker.become('installed');
    });

    expect(prompt()).toHaveTextContent('Update available');
    expect(screen.getByRole('button', {name: 'Reload'})).toBeInTheDocument();
    expect(worker.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('when a new version was already waiting at start, then it is offered at once', async () => {
    const container = new FakeContainer({});
    container.registration.waiting = new FakeWorker();
    container.registration.waiting.state = 'installed';
    render(<UpdatePrompt container={container} reload={vi.fn()} />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Update available',
    );
  });

  it('when the prompt is ignored, then it stays and never swaps on its own (guards an auto-swap mid-session)', async () => {
    vi.useFakeTimers();
    const container = new FakeContainer({});
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    container.registration.waiting = waiting;
    const reload = vi.fn();
    render(<UpdatePrompt container={container} reload={reload} />);
    await act(() => vi.advanceTimersByTimeAsync(10 * 60 * 1000));

    expect(prompt()).toHaveTextContent('Update available');
    expect(waiting.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('when the clinician taps Reload, then the waiting worker is told to take over and the page reloads once it has', async () => {
    const container = new FakeContainer({});
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    container.registration.waiting = waiting;
    const reload = vi.fn();
    render(<UpdatePrompt container={container} reload={reload} />);

    await userEvent.click(await screen.findByRole('button', {name: 'Reload'}));

    expect(waiting.messages).toEqual([SKIP_WAITING_MESSAGE]);
    expect(reload).not.toHaveBeenCalled();
    act(() => {
      container.changeController();
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('when the controller changes without the clinician asking (another tab chose Reload), then this page does not reload by itself', async () => {
    const container = new FakeContainer({});
    const reload = vi.fn();
    render(<UpdatePrompt container={container} reload={reload} />);
    await act(() => Promise.resolve());

    act(() => {
      container.changeController();
    });

    expect(reload).not.toHaveBeenCalled();
  });

  it('when the app comes back to the foreground, then it checks for a new version', async () => {
    const container = new FakeContainer({});
    render(<UpdatePrompt container={container} reload={vi.fn()} />);
    await act(() => Promise.resolve());

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(container.registration.update).toHaveBeenCalled();
  });
});

describe('given no service worker (development, or a browser without one)', () => {
  it('when the app runs, then nothing is registered or shown', () => {
    render(<UpdatePrompt container={undefined} reload={vi.fn()} />);

    expect(prompt()).not.toBeInTheDocument();
  });
});
