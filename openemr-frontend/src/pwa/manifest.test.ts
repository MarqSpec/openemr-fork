// @vitest-environment node
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {DARK_TOKENS, LIGHT_TOKENS} from '../theme/tokens';

// reference: REQUIREMENTS.md FR-PWA-1, NFR-COMPAT-1

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const INDEX_HTML = readFileSync(
  fileURLToPath(new URL('../../index.html', import.meta.url)),
  'utf8',
);

const manifestIcon = z.object({
  src: z.string().startsWith('/'),
  sizes: z.string().regex(/^\d+x\d+$/),
  type: z.literal('image/png'),
  purpose: z.enum(['any', 'maskable']),
});

const webAppManifest = z.object({
  id: z.string(),
  name: z.string().min(1),
  short_name: z.string().min(1).max(12),
  description: z.string().min(1),
  start_url: z.string(),
  scope: z.string(),
  display: z.string(),
  theme_color: z.string(),
  background_color: z.string(),
  icons: z.array(manifestIcon),
});

function readManifest(): z.infer<typeof webAppManifest> {
  const raw: unknown = JSON.parse(
    readFileSync(`${PUBLIC_DIR}manifest.webmanifest`, 'utf8'),
  );
  return webAppManifest.parse(raw);
}

/** Attribute maps of every `<tag …>` in the page head, without a DOM. */
function tags(name: string): Record<string, string>[] {
  const pattern = new RegExp(`<${name}\\b([^>]*)>`, 'g');
  return [...INDEX_HTML.matchAll(pattern)].map(match =>
    Object.fromEntries(
      [...(match[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [
        attribute[1] ?? '',
        attribute[2] ?? '',
      ]),
    ),
  );
}

describe('given the web app manifest', () => {
  it('then it names the app and launches standalone at the root, scoped to the whole origin', () => {
    const manifest = readManifest();
    expect(manifest.name).toBe('OpenEMR Patient Dashboard');
    expect(manifest.short_name).toBe('OpenEMR');
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('then its colours come from the light theme tokens: the app bar surface and the page grey', () => {
    const manifest = readManifest();
    expect(manifest.theme_color).toBe(LIGHT_TOKENS.surface);
    expect(manifest.background_color).toBe(LIGHT_TOKENS.page);
  });

  it('then it lists a 192 and a 512 icon for any purpose and as maskable', () => {
    const listed = readManifest().icons.map(
      icon => `${icon.purpose}@${icon.sizes}`,
    );
    expect(listed).toEqual(
      expect.arrayContaining([
        'any@192x192',
        'any@512x512',
        'maskable@192x192',
        'maskable@512x512',
      ]),
    );
  });

  // That each listed icon is one scripts/icons/ generates: scripts/icons/icon_set.test.ts.
  it('then every icon it lists is a file under public/icons/ whose real dimensions match its declared sizes', () => {
    for (const icon of readManifest().icons) {
      expect(icon.src).toMatch(/^\/icons\/[\w-]+\.png$/);
      const file = `${PUBLIC_DIR}${icon.src.slice(1)}`;
      expect(existsSync(file)).toBe(true);
      const png = PNG.sync.read(readFileSync(file));
      expect(`${String(png.width)}x${String(png.height)}`).toBe(icon.sizes);
    }
  });
});

describe('given the app shell index.html', () => {
  it('then it links the manifest', () => {
    expect(tags('link')).toContainEqual({
      rel: 'manifest',
      href: '/manifest.webmanifest',
    });
  });

  it('then the browser chrome follows the device theme: a theme-color per colour scheme', () => {
    const themeColors = tags('meta').filter(
      meta => meta.name === 'theme-color',
    );
    expect(themeColors).toEqual(
      expect.arrayContaining([
        {
          name: 'theme-color',
          media: '(prefers-color-scheme: light)',
          content: LIGHT_TOKENS.surface,
        },
        {
          name: 'theme-color',
          media: '(prefers-color-scheme: dark)',
          content: DARK_TOKENS.surface,
        },
      ]),
    );
  });

  it('then iOS gets an opaque apple-touch-icon (NFR-COMPAT-1 best-effort)', () => {
    const href = '/icons/apple-touch-icon.png';
    expect(tags('link')).toContainEqual({rel: 'apple-touch-icon', href});
    const png = PNG.sync.read(readFileSync(`${PUBLIC_DIR}${href.slice(1)}`));
    expect([png.width, png.height]).toEqual([180, 180]);
  });
});
