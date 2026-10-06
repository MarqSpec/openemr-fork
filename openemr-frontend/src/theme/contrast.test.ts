import {describe, expect, it} from 'vitest';

import {contrastRatio, renderedColour} from './contrast';

// reference: REQUIREMENTS.md NFR-A11Y-1

// What Chromium computes for a dark-mode menu Paper (MUI elevation 8): the surface token, then the white overlay.
const DARK_MENU_COLOUR = 'rgb(33, 37, 41)';
const DARK_MENU_OVERLAY =
  'linear-gradient(rgba(255, 255, 255, 0.118), rgba(255, 255, 255, 0.118))';

describe('given the CSS paint layers of an element, bottom first', () => {
  it('when there is only an opaque colour, then it renders as that colour', () => {
    expect(renderedColour(DARK_MENU_COLOUR)).toBe('#212529');
    expect(renderedColour('#0069d9')).toBe('#0069d9');
  });

  it('when there is no background image, then the colour is unchanged', () => {
    expect(renderedColour(DARK_MENU_COLOUR, 'none')).toBe('#212529');
  });

  it("when MUI's elevation overlay is painted over the colour, then it renders as the blend the screen shows", () => {
    // The pixel the review sampled beside the ring: #3b3f42.
    expect(renderedColour(DARK_MENU_COLOUR, DARK_MENU_OVERLAY)).toBe('#3b3f42');
  });

  it('when a translucent colour sits on top, then it is blended over the layers below', () => {
    expect(renderedColour('#000000', 'rgba(255, 255, 255, 0.5)')).toBe(
      '#808080',
    );
    expect(renderedColour('#ffffff', 'rgb(0 0 0 / 25%)')).toBe('#bfbfbf');
    expect(renderedColour(DARK_MENU_COLOUR, 'rgba(0, 0, 0, 0)')).toBe(
      '#212529',
    );
  });

  it('when a ring passes 3:1 on the background-color but not on the rendered surface, then the rendered ratio is below 3:1 (guards a check that ignores the overlay)', () => {
    const ring = '#2a78d8';
    expect(contrastRatio(ring, '#212529')).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(ring, renderedColour(DARK_MENU_COLOUR, DARK_MENU_OVERLAY)),
    ).toBeLessThan(3);
  });

  it('when the bottom layer is not opaque, then it throws, because what shows through is unknown', () => {
    expect(() => renderedColour('rgba(33, 37, 41, 0.5)')).toThrow();
  });

  it('when a gradient changes colour, or a layer is an image or not a colour, then it throws rather than guess', () => {
    expect(() =>
      renderedColour(
        DARK_MENU_COLOUR,
        'linear-gradient(rgb(255, 255, 255), rgb(0, 0, 0))',
      ),
    ).toThrow();
    expect(() => renderedColour(DARK_MENU_COLOUR, 'url("a.png")')).toThrow();
    expect(() => renderedColour('blue')).toThrow();
  });
});
