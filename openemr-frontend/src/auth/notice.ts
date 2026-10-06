/** A fixed message shown above the sign-in action. Text is always the app's own — never from a URL or a server. */
export interface Notice {
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly body: string;
}
