import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {LIGHT_TOKENS} from '../../src/theme/tokens.ts';
import {
  ICON_BACKGROUND,
  ICON_FOREGROUND,
  ICON_SPECS,
  MASKABLE_SAFE_ZONE_RADIUS,
  committedIconPath,
  readSourceLogo,
  renderIcon,
} from './icon_set.ts';

// reference: REQUIREMENTS.md FR-PWA-1

const MANIFEST_PATH = fileURLToPath(
  new URL('../../public/manifest.webmanifest', import.meta.url),
);
const INDEX_HTML_PATH = fileURLToPath(
  new URL('../../index.html', import.meta.url),
);

/** Anti-aliasing may differ by a step between platforms; anything more is drift. */
const CHANNEL_TOLERANCE = 2;

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function largestChannelDifference(a: Uint8Array, b: Uint8Array): number {
  let largest = 0;
  for (let i = 0; i < a.length; i += 1) {
    largest = Math.max(largest, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return largest;
}

describe('given the icon set generated from OpenEMR menu logo', () => {
  it('then the icons use the light theme text colour on its opaque surface colour', () => {
    expect(ICON_FOREGROUND).toBe(LIGHT_TOKENS.text);
    expect(ICON_BACKGROUND).toBe(LIGHT_TOKENS.surface);
  });

  it('then it covers 192 and 512 for any purpose and as maskable, plus a 180 apple-touch-icon', () => {
    const summary = ICON_SPECS.map(
      spec => `${spec.purpose}@${String(spec.size)}`,
    );
    expect(summary).toEqual(
      expect.arrayContaining([
        'any@192',
        'any@512',
        'maskable@192',
        'maskable@512',
        'apple-touch@180',
      ]),
    );
  });

  it('then the web app manifest lists each any and maskable icon it generates, with its size and purpose', () => {
    const manifest = z
      .object({
        icons: z.array(
          z.object({src: z.string(), sizes: z.string(), purpose: z.string()}),
        ),
      })
      .parse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
    const listed = manifest.icons.map(
      icon => `${icon.src} ${icon.sizes} ${icon.purpose}`,
    );
    const generated = ICON_SPECS.filter(
      spec => spec.purpose !== 'apple-touch',
    ).map(
      spec =>
        `/icons/${spec.file} ${String(spec.size)}x${String(spec.size)} ${spec.purpose}`,
    );
    expect([...listed].sort()).toEqual([...generated].sort());
  });

  it('then index.html links the apple-touch icon it generates', () => {
    const apple = ICON_SPECS.find(spec => spec.purpose === 'apple-touch');
    expect(apple).toBeDefined();
    expect(readFileSync(INDEX_HTML_PATH, 'utf8')).toContain(
      `<link rel="apple-touch-icon" href="/icons/${apple?.file ?? ''}" />`,
    );
  });

  describe.each(ICON_SPECS.map(spec => [spec.file, spec] as const))(
    'given the committed %s',
    (_file, spec) => {
      const committedPath = committedIconPath(spec);

      it('then it exists', () => {
        expect(existsSync(committedPath)).toBe(true);
      });

      it('then it has the declared dimensions and is fully opaque', () => {
        const png = PNG.sync.read(readFileSync(committedPath));
        expect([png.width, png.height]).toEqual([spec.size, spec.size]);
        for (let i = 3; i < png.data.length; i += 4) {
          if (png.data[i] !== 255) {
            throw new Error(`pixel ${String((i - 3) / 4)} is not opaque`);
          }
        }
      });

      it('when the script renders it again from the source SVG, then the committed file has not drifted', () => {
        const fresh = renderIcon(spec, readSourceLogo());
        const committed = PNG.sync.read(readFileSync(committedPath));
        expect([fresh.width, fresh.height]).toEqual([
          committed.width,
          committed.height,
        ]);
        expect(
          largestChannelDifference(fresh.pixels, committed.data),
        ).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
      });

      it('then the logo is drawn: it holds foreground pixels, not just background', () => {
        const png = PNG.sync.read(readFileSync(committedPath));
        const [r, g, b] = hexToRgb(ICON_FOREGROUND);
        let foreground = 0;
        for (let i = 0; i < png.data.length; i += 4) {
          if (
            png.data[i] === r &&
            png.data[i + 1] === g &&
            png.data[i + 2] === b
          ) {
            foreground += 1;
          }
        }
        expect(foreground / (spec.size * spec.size)).toBeGreaterThan(0.05);
      });
    },
  );

  describe.each(
    ICON_SPECS.filter(spec => spec.purpose === 'maskable').map(
      spec => [spec.file, spec] as const,
    ),
  )('given the maskable %s', (_file, spec) => {
    it('then nothing but background lies outside the safe-zone circle, so no launcher mask crops the logo', () => {
      const png = PNG.sync.read(readFileSync(committedIconPath(spec)));
      const [r, g, b] = hexToRgb(ICON_BACKGROUND);
      const centre = spec.size / 2;
      const radius = spec.size * MASKABLE_SAFE_ZONE_RADIUS;
      for (let y = 0; y < spec.size; y += 1) {
        for (let x = 0; x < spec.size; x += 1) {
          if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) <= radius) {
            continue;
          }
          const i = (y * spec.size + x) * 4;
          const pixel = [png.data[i], png.data[i + 1], png.data[i + 2]];
          if (pixel[0] !== r || pixel[1] !== g || pixel[2] !== b) {
            throw new Error(
              `pixel (${String(x)}, ${String(y)}) outside the safe zone is not background`,
            );
          }
        }
      }
    });
  });
});
