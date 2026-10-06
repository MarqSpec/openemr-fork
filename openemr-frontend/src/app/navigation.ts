import {useSyncExternalStore} from 'react';

// The app's history: paths only, never state, a query string or a hash — so nothing identifying enters the URL
// or the history entry. reference: REQUIREMENTS.md FR-PAT-2, NFR-SEC-6

const NAVIGATED = 'openemr-frontend:navigated';

/** Moves to an in-app path, adding one history entry so Back returns; the same path adds nothing. */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

function currentPath(): string {
  return window.location.pathname;
}

/** The current path; re-renders on {@link navigate} and on Back / Forward. */
export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}
