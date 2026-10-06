import {setupServer} from 'msw/node';

/** The one MSW server for unit/component tests; each test adds its own handlers with `server.use`. */
export const server = setupServer();
