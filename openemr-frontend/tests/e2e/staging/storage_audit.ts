import {expect, type Page} from '@playwright/test';

import {THEME_PREFERENCE_KEY} from '../../../src/theme/theme_preference';

// Storage audit helpers (NFR-SEC-1). Reads every browser store the SPA can write.
// reference: REQUIREMENTS.md NFR-SEC-1, CONVENTIONS.md

/** Strings that must never appear in browser-accessible storage. */
export const FORBIDDEN_PATTERNS = [
  'eyJ', // JWT header prefix (base64url)
  'code_verifier',
  'code_challenge',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
] as const;

/** Allowed localStorage keys per NFR-SEC-1 (theme choice; card collapse when persisted). */
export const ALLOWED_LS_KEYS = new Set<string>([THEME_PREFERENCE_KEY]);

export function assertNoForbidden(label: string, content: string) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    expect(
      content,
      `${label} must not contain "${pattern}" (token/secret leak)`,
    ).not.toContain(pattern);
  }
}

/** True when the string looks like clinical text we must not persist (names, MRNs from the chart). */
export function assertNoClinical(
  label: string,
  content: string,
  samples: string[],
) {
  for (const sample of samples) {
    const trimmed = sample.trim();
    if (trimmed.length >= 3) {
      expect(
        content,
        `${label} must not contain on-screen clinical text "${trimmed}" (PHI leak)`,
      ).not.toContain(trimmed);
    }
  }
}

export async function dumpWebStorage(page: Page): Promise<string> {
  return page.evaluate(() =>
    [localStorage, sessionStorage]
      .flatMap(store =>
        Array.from({length: store.length}, (_, i) => {
          const key = store.key(i) ?? '';
          return `${key}=${store.getItem(key) ?? ''}`;
        }),
      )
      .join('\n'),
  );
}

export async function dumpIndexedDb(page: Page): Promise<string> {
  return page.evaluate(async () => {
    if (typeof indexedDB.databases !== 'function') return '';
    const parts: string[] = [];
    for (const meta of await indexedDB.databases()) {
      const dbName = meta.name;
      if (!dbName) continue;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => {
          reject(open.error ?? new Error('IndexedDB open failed'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const stores = Array.from(db.objectStoreNames);
          if (stores.length === 0) {
            db.close();
            resolve();
            return;
          }
          let pending = stores.length;
          for (const storeName of stores) {
            const tx = db.transaction(storeName, 'readonly');
            const all = tx.objectStore(storeName).getAll();
            all.onerror = () => {
              reject(all.error ?? new Error('IndexedDB getAll failed'));
            };
            all.onsuccess = () => {
              parts.push(
                `${dbName}/${storeName}=${JSON.stringify(all.result)}`,
              );
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve();
              }
            };
          }
        };
      });
    }
    return parts.join('\n');
  });
}

/** Every Cache Storage entry body — not just its URL. */
export async function dumpCacheBodies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const bodies: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const resp = await cache.match(req);
        if (resp) {
          try {
            bodies.push(await resp.text());
          } catch {
            // opaque or unreadable — skip
          }
        }
      }
    }
    return bodies;
  });
}

export async function assertAllowedLocalStorageKeys(page: Page) {
  const lsKeys = await page.evaluate(() =>
    Array.from(
      {length: localStorage.length},
      (_, i) => localStorage.key(i) ?? '',
    ),
  );
  for (const key of lsKeys) {
    expect(
      ALLOWED_LS_KEYS.has(key),
      `localStorage key "${key}" is not in the allowed set (NFR-SEC-1)`,
    ).toBe(true);
  }
}
