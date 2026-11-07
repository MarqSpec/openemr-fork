import {http, HttpResponse} from 'msw';
import {setupServer} from 'msw/node';

/**
 * API-48 as a token handler with neither PATIENT_APPS nor PRIVACY_GRACE_SECONDS set answers it: every signed-in
 * render needs it (SessionProvider waits for it), so it is the one answer the server starts with. It survives
 * `resetHandlers`; a test that cares about the config answers it itself with `server.use`.
 */
const UNCONFIGURED_RUNTIME_CONFIG = http.get('/bff/config', () =>
  HttpResponse.json({patientApps: [], privacyGraceSeconds: 60}),
);

/** The one MSW server for unit/component tests; each test adds its own handlers with `server.use`. */
export const server = setupServer(UNCONFIGURED_RUNTIME_CONFIG);
