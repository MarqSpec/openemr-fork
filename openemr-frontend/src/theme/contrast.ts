const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function relativeLuminance(hex: string): number {
  if (!HEX_COLOUR.test(hex)) {
    throw new Error(`Expected a #rrggbb colour, got "${hex}"`);
  }
  const linear = (start: number): number => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1 to 21, order-independent). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const CSS_RGB =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/;
const FLAT_GRADIENT = /^linear-gradient\((.*)\)$/;

function parseColour(css: string): Rgba {
  if (HEX_COLOUR.test(css)) {
    const [r, g, b] = [1, 3, 5].map(start =>
      parseInt(css.slice(start, start + 2), 16),
    ) as [number, number, number];
    return {r, g, b, a: 1};
  }
  const match = CSS_RGB.exec(css);
  if (match === null) {
    throw new Error(`Expected an rgb()/rgba() or #rrggbb colour, got "${css}"`);
  }
  const [, r = '', g = '', b = '', alpha, percent] = match;
  const a =
    alpha === undefined ? 1 : Number(alpha) / (percent === '%' ? 100 : 1);
  return {r: Number(r), g: Number(g), b: Number(b), a};
}

/** A background-image layer that paints one colour: MUI's dark-mode elevation overlay is linear-gradient(c, c). */
function parseLayer(css: string): Rgba | null {
  if (css === 'none') return null;
  const gradient = FLAT_GRADIENT.exec(css);
  if (gradient === null) return parseColour(css);
  const stops = (gradient[1] ?? '').split(/,(?![^(]*\))/).map(s => s.trim());
  const [first, ...rest] = stops;
  if (first === undefined || rest.some(stop => stop !== first)) {
    throw new Error(
      `Expected a single-colour gradient, got "${css}"; sample the rendered pixel instead`,
    );
  }
  return parseColour(first);
}

const toHex = (channel: number) =>
  Math.round(channel).toString(16).padStart(2, '0');

/**
 * The #rrggbb an element's paint layers render as, bottom first: an opaque colour, then any translucent colours
 * or single-colour gradients over it. A contrast check against a MUI Paper passes its computed backgroundColor
 * then backgroundImage, because in dark mode the elevation overlay lightens the surface.
 */
export function renderedColour(base: string, ...layers: string[]): string {
  const bottom = parseColour(base);
  if (bottom.a !== 1) {
    throw new Error(`Expected an opaque bottom layer, got "${base}"`);
  }
  const {r, g, b} = layers.reduce<Rgba>((below, css) => {
    const layer = parseLayer(css);
    if (layer === null) return below;
    const mix = (top: number, under: number) =>
      top * layer.a + under * (1 - layer.a);
    return {
      r: mix(layer.r, below.r),
      g: mix(layer.g, below.g),
      b: mix(layer.b, below.b),
      a: 1,
    };
  }, bottom);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
