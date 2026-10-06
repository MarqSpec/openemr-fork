import {Resvg} from '@resvg/resvg-js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {LIGHT_TOKENS} from '../../src/theme/tokens.ts';

// reference: REQUIREMENTS.md FR-PWA-1 · src/theme/tokens.ts

/** OpenEMR's vector menu logo, the one the app bar inlines (src/brand/OpenEmrLogo.tsx). */
export const SOURCE_LOGO_URL = new URL(
  '../../../public/images/logos/core/menu/primary/logo.svg',
  import.meta.url,
);
export const ICON_DIR_URL = new URL('../../public/icons/', import.meta.url);

/**
 * One colour pair for every icon, because a launcher icon cannot follow the in-app theme: the light theme's
 * text on its surface, i.e. the logo exactly as the light app bar shows it, on an opaque background.
 */
export const ICON_FOREGROUND = LIGHT_TOKENS.text;
export const ICON_BACKGROUND = LIGHT_TOKENS.surface;

/** The W3C maskable safe zone: a centred circle of 40% of the icon's size (radius). */
export const MASKABLE_SAFE_ZONE_RADIUS = 0.4;

export type IconPurpose = 'any' | 'maskable' | 'apple-touch';

export interface IconSpec {
  readonly file: string;
  readonly size: number;
  readonly purpose: IconPurpose;
  /** The logo's longer side as a fraction of the icon's side. */
  readonly logoScale: number;
}

// Maskable: the logo is a ring, so its box's corners are empty; 0.64 keeps every drawn pixel inside the safe
// zone with a margin (icon_set.test.ts checks each one).
export const ICON_SPECS: readonly IconSpec[] = [
  {file: 'icon-192.png', size: 192, purpose: 'any', logoScale: 0.75},
  {file: 'icon-512.png', size: 512, purpose: 'any', logoScale: 0.75},
  {
    file: 'icon-maskable-192.png',
    size: 192,
    purpose: 'maskable',
    logoScale: 0.64,
  },
  {
    file: 'icon-maskable-512.png',
    size: 512,
    purpose: 'maskable',
    logoScale: 0.64,
  },
  // iOS rounds the corners itself and ignores transparency, so an opaque full-bleed square.
  {
    file: 'apple-touch-icon.png',
    size: 180,
    purpose: 'apple-touch',
    logoScale: 0.7,
  },
];

export interface RenderedIcon {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major. */
  readonly pixels: Uint8Array;
  readonly png: Buffer;
}

export function committedIconPath(spec: IconSpec): string {
  return fileURLToPath(new URL(spec.file, ICON_DIR_URL));
}

export function readSourceLogo(): string {
  return readFileSync(SOURCE_LOGO_URL, 'utf8');
}

const RENDER_OPTIONS = {
  fitTo: {mode: 'original'},
  font: {loadSystemFonts: false},
  logLevel: 'off',
} as const;

/** Renders one icon: the source logo's drawn content, fitted and centred on an opaque square. */
export function renderIcon(spec: IconSpec, sourceSvg: string): RenderedIcon {
  const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(sourceSvg)?.[1];
  if (inner === undefined) throw new Error('source logo has no <svg> root');
  const box = new Resvg(sourceSvg, RENDER_OPTIONS).getBBox();
  if (box === undefined) throw new Error('source logo draws nothing');

  const {size} = spec;
  const scale = (size * spec.logoScale) / Math.max(box.width, box.height);
  const width = box.width * scale;
  const height = box.height * scale;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}">`,
    `<rect width="${String(size)}" height="${String(size)}" fill="${ICON_BACKGROUND}"/>`,
    `<svg x="${String((size - width) / 2)}" y="${String((size - height) / 2)}"`,
    ` width="${String(width)}" height="${String(height)}"`,
    ` viewBox="${[box.x, box.y, box.width, box.height].map(String).join(' ')}"`,
    ` fill="${ICON_FOREGROUND}">${inner}</svg>`,
    '</svg>',
  ].join('');

  const rendered = new Resvg(svg, RENDER_OPTIONS).render();
  return {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8Array(rendered.pixels),
    png: rendered.asPng(),
  };
}
