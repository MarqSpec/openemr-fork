import {describe, expect, it} from 'vitest';
import {start} from './start.js';

describe('given the process starts with an invalid environment', () => {
  it('when start runs, then it reports every problem on stderr, never a value, and does not listen', async () => {
    const written: string[] = [];

    const server = await start(
      {
        OPENEMR_BASE_URL:
          'https://admin:synthetic-password@openemr.example.test',
        PORT: 'eighty',
      },
      {writeError: line => written.push(line)},
    );

    expect(server).toBeUndefined();
    const output = written.join('');
    expect(output).toMatch(/invalid configuration/i);
    expect(output).toContain('OPENEMR_BASE_URL');
    expect(output).toContain('BFF_SPA_DIST_DIR');
    expect(output).toContain('PORT');
    expect(output).not.toContain('synthetic-password');
    expect(output).not.toContain('eighty');
  });
});

describe('given the OAuth client secret is set but the environment is otherwise invalid', () => {
  it('when start runs, then stderr names the problems and never contains the secret', async () => {
    const written: string[] = [];

    const server = await start(
      {
        OPENEMR_BASE_URL: 'https://openemr.example.test',
        OAUTH_CLIENT_ID: 'synthetic-client-id',
        OAUTH_CLIENT_SECRET: ' SYNTHETIC-SECRET-SENTINEL-start ',
      },
      {writeError: line => written.push(line)},
    );

    expect(server).toBeUndefined();
    const output = written.join('');
    expect(output).toContain('OAUTH_CLIENT_SECRET');
    expect(output).toContain('BFF_PUBLIC_ORIGIN');
    expect(output).not.toContain('SYNTHETIC-SECRET-SENTINEL-start');
  });
});
