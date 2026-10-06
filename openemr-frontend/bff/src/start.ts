import type {FastifyInstance} from 'fastify';
import {ConfigError, loadConfig} from './config.js';
import {buildServer} from './server.js';

export interface StartIo {
  writeError: (text: string) => void;
}

/**
 * Parses the environment and starts listening; on invalid configuration it reports every problem and returns
 * `undefined` so the caller exits non-zero before anything is served.
 */
export async function start(
  env: Readonly<Record<string, string | undefined>>,
  io: StartIo,
): Promise<FastifyInstance | undefined> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error;
    io.writeError(`${error.message}\n`);
    return undefined;
  }
  const app = buildServer(config);
  await app.listen({port: config.port, host: config.host});
  return app;
}
