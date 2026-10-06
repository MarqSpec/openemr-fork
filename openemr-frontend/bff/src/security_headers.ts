/**
 * The headers NFR-SEC-2 puts on every response the token handler sends.
 * reference: REQUIREMENTS.md NFR-SEC-2, FR-BFF-6
 */
export function securityHeaders(
  authorizeOrigin: string,
): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // MUI's Emotion injects <style> elements at runtime; scripts stay strict. Why not a nonce: NFR-SEC-2.
    "style-src 'self' 'unsafe-inline'",
    // The browser talks only to its own origin's /bff/*, never to OpenEMR.
    "connect-src 'self'",
    // Sign-in is a top-level form post that redirects to OpenEMR's authorize endpoint.
    `form-action 'self' ${authorizeOrigin}`,
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'strict-transport-security': 'max-age=31536000',
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  };
}
