import {useCallback, useEffect, useRef, useState} from 'react';

// Registers the service worker and notices a new version waiting. It never activates one on its own: only
// `apply()`, from the clinician's Reload, does (FR-PWA-3). reference: REQUIREMENTS.md FR-PWA-3

export const SERVICE_WORKER_URL = '/sw.js';
/** Must match worker.ts `SKIP_WAITING` (worker.test.ts checks). */
export const SKIP_WAITING_MESSAGE = {type: 'SKIP_WAITING'} as const;

/** The slice of `ServiceWorker` used here, so tests can pass a fake. */
export interface WorkerHandle {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationHandle {
  readonly waiting: WorkerHandle | null;
  readonly installing: WorkerHandle | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

export interface WorkerContainer {
  /** Null until a worker controls the page: then a new worker is the first install, not an update. */
  readonly controller: object | null;
  register(
    url: string,
    options: {readonly scope: string},
  ): Promise<RegistrationHandle>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/** The browser's worker container in a production build; none in development (Vite's dev server has no worker). */
export function serviceWorkerContainer(): WorkerContainer | undefined {
  return import.meta.env.PROD && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined;
}

export interface ServiceWorkerUpdate {
  /** A new version is installed and waiting for the clinician. */
  readonly ready: boolean;
  /** Tells the waiting worker to take over, then reloads once it has. */
  readonly apply: () => void;
}

export function useServiceWorkerUpdate(
  container: WorkerContainer | undefined,
  reload: () => void,
): ServiceWorkerUpdate {
  const [waiting, setWaiting] = useState<WorkerHandle | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (container === undefined) return;
    let registration: RegistrationHandle | undefined;
    let live = true;
    const offer = (worker: WorkerHandle | null) => {
      // No controller: this is the first install, and there is nothing to update from.
      if (live && worker !== null && container.controller !== null) {
        setWaiting(worker);
      }
    };
    const onControllerChange = () => {
      if (asked.current) reload();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void registration?.update();
    };
    container.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisible);
    container
      .register(SERVICE_WORKER_URL, {scope: '/'})
      .then(found => {
        registration = found;
        offer(found.waiting);
        found.addEventListener('updatefound', () => {
          const installing = found.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') offer(installing);
          });
        });
      })
      .catch(() => {
        // No worker (private mode, blocked): the app still runs, only without an offline shell.
      });
    return () => {
      live = false;
      container.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [container, reload]);

  const apply = useCallback(() => {
    if (waiting === null) return;
    asked.current = true;
    waiting.postMessage(SKIP_WAITING_MESSAGE);
  }, [waiting]);

  return {ready: waiting !== null, apply};
}
