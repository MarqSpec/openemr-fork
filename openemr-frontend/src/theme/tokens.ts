/**
 * The only source of colour in the app. Values come from OpenEMR's own themes
 * (interface/themes/oe-styles/style_light.scss, style_dark.scss); every deviation
 * exists to reach WCAG AA.
 */
export interface ThemeTokens {
  readonly page: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly line: string;
  readonly text: string;
  readonly muted: string;
  readonly link: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly warning: string;
  readonly onWarning: string;
  readonly danger: string;
  /** Text on a filled danger surface (the deceased chip, FR-HDR-2). */
  readonly onDanger: string;
  readonly success: string;
  readonly info: string;
}

/** Minimum edge of an interactive target, in CSS px (= dp on Android) — NFR-A11Y-2. */
export const TOUCH_TARGET = 48;

export const LIGHT_TOKENS: ThemeTokens = {
  page: '#e6e6e6',
  surface: '#ffffff',
  surfaceAlt: '#f3f4f6',
  line: '#d1d5db',
  text: '#111827',
  // style_light gray-600; gray-500 (#6b7280) is only 3.87:1 on the page grey.
  muted: '#4b5563',
  link: '#1d4ed8',
  // style_light #007bff gives white text only 3.98:1; Bootstrap's own hover shade reaches 5.2:1.
  primary: '#0069d9',
  onPrimary: '#ffffff',
  warning: '#ffc107',
  onWarning: '#111827',
  // Bootstrap's pressed danger shade; #dc3545 is 3.6:1 on the page grey.
  danger: '#bd2130',
  onDanger: '#ffffff',
  // Bootstrap's pressed success / info shades; #28a745 and #17a2b8 fail AA on white and on the page grey.
  success: '#19692c',
  info: '#0f6674',
};

export const DARK_TOKENS: ThemeTokens = {
  page: '#000000',
  surface: '#212529',
  surfaceAlt: '#343a40',
  line: '#495057',
  text: '#f8f9fa',
  muted: '#ced4da',
  // style_dark links are #f0f0f0 — indistinguishable from body text.
  link: '#8ab8ff',
  primary: '#3b95ff',
  onPrimary: '#000000',
  warning: '#ffc107',
  onWarning: '#111111',
  danger: '#ff6b6b',
  // White on the lifted dark danger is 2.8:1; black is 7.6:1.
  onDanger: '#000000',
  success: '#5dd879',
  info: '#5bc8da',
};
