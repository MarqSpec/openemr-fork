import {describe, expect, it} from 'vitest';
import {judgeProvenance} from './csrf.js';

const ORIGIN = 'https://frontend.example.test';

describe('given a state-changing /bff/* request and the FR-BFF-6 provenance rule', () => {
  describe('when the browser sends Sec-Fetch-Site, then it decides alone', () => {
    it.each([
      ['same-origin', ORIGIN, true],
      // A same-origin form post may carry Origin: null under some referrer policies; Sec-Fetch-Site still decides.
      ['same-origin', 'null', true],
      ['same-origin', undefined, true],
      ['same-origin', 'https://evil.example.test', true],
      ['same-site', ORIGIN, false],
      ['cross-site', ORIGIN, false],
      ['cross-site', undefined, false],
      // A typed-in URL or bookmark never posts a form, so `none` is not the app's own form.
      ['none', ORIGIN, false],
      ['Same-Origin', ORIGIN, false],
      ['same-origin, cross-site', ORIGIN, false],
      ['', ORIGIN, false],
    ])(
      'Sec-Fetch-Site %j with Origin %j → allowed: %s',
      (secFetchSite, origin, allowed) => {
        const verdict = judgeProvenance(
          {
            'sec-fetch-site': secFetchSite,
            ...(origin === undefined ? {} : {origin}),
          },
          ORIGIN,
        );
        expect(verdict.allowed).toBe(allowed);
      },
    );
  });

  describe('when Sec-Fetch-Site is absent, then Origin decides', () => {
    it.each([
      [ORIGIN, true],
      ['https://evil.example.test', false],
      ['null', false],
      [`${ORIGIN}/`, false],
      ['http://frontend.example.test', false],
      ['https://frontend.example.test:8443', false],
      ['https://FRONTEND.example.test', false],
      ['https://frontend.example.test.evil.example', false],
      ['', false],
    ])('Origin %j → allowed: %s', (origin, allowed) => {
      expect(judgeProvenance({origin}, ORIGIN).allowed).toBe(allowed);
    });

    it('with neither header, then the request is rejected', () => {
      expect(judgeProvenance({}, ORIGIN)).toEqual({
        allowed: false,
        reason: 'no_provenance',
      });
    });
  });

  it('when rejected, then the reason names the rule that failed, never a header value', () => {
    expect(judgeProvenance({'sec-fetch-site': 'cross-site'}, ORIGIN)).toEqual({
      allowed: false,
      reason: 'sec_fetch_site',
    });
    expect(
      judgeProvenance({origin: 'https://evil.example.test'}, ORIGIN),
    ).toEqual({allowed: false, reason: 'origin_mismatch'});
  });
});
