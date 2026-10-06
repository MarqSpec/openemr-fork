import {http, HttpResponse} from 'msw';
import {describe, expect, it} from 'vitest';

import {server} from '../../test/msw_server';
import {
  CANARY,
  operationOutcome,
  patient,
  searchBundle,
} from '../../test/fhir_fixtures';
import {ApiError} from '../api_error';
import {
  PATIENT_PAGE_SIZE,
  parsePatientSearch,
  type PatientSearch,
} from './patient_search';
import {searchPatients} from './resources';

// reference: INTERFACES.md API-11 · REQUIREMENTS.md FR-PAT-1, NFR-SEC-6 · REQUIREMENTS.md BUG-7

const BLANK = {name: '', birthDate: '', mrn: ''};

function parsed(input: Partial<typeof BLANK>): PatientSearch {
  const result = parsePatientSearch({...BLANK, ...input});
  if (!result.ok) throw new Error('expected a valid search');
  return result.search;
}

/** Answers API-11 and records every query string it was sent. */
function answerPatientSearch(
  respond: () => Response = () => HttpResponse.json(searchBundle([])),
): URLSearchParams[] {
  const sent: URLSearchParams[] = [];
  server.use(
    http.get('/bff/fhir/Patient', ({request}) => {
      sent.push(new URL(request.url).searchParams);
      return respond();
    }),
  );
  return sent;
}

function patients(count: number, first = 0): unknown[] {
  return Array.from({length: count}, (_, index) =>
    patient({id: `test-patient-${String(first + index).padStart(4, '0')}`}),
  );
}

describe('given what a clinician typed into the search form', () => {
  it('when every field is blank, then it is refused as empty and nothing can be searched', () => {
    expect(parsePatientSearch(BLANK)).toEqual({
      ok: false,
      problems: {},
      empty: true,
    });
  });

  it('when the name has one letter, then it is refused as too short (FR-PAT-1: at least 2 characters)', () => {
    expect(parsePatientSearch({...BLANK, name: ' F '})).toEqual({
      ok: false,
      empty: false,
      problems: {name: 'name-too-short'},
    });
  });

  it('when the name holds a digit or a symbol the token handler would refuse, then it is refused before any request (guards a 404 from the allow-list)', () => {
    for (const name of ['Te5t', 'Test;', 'Test%']) {
      expect(parsePatientSearch({...BLANK, name})).toMatchObject({
        ok: false,
        problems: {name: 'name-characters'},
      });
    }
  });

  it('when the name has letters, accents, an apostrophe, a hyphen, a full stop or a space, then it is accepted, trimmed', () => {
    expect(parsed({name: "  O'Brién-Test Jr. "}).name).toBe("O'Brién-Test Jr.");
  });

  it('when the date of birth is not a full YYYY-MM-DD date, then it is refused', () => {
    for (const birthDate of ['1970', '1970-13-01', '01/02/1970', '1970-1-1']) {
      expect(parsePatientSearch({...BLANK, birthDate})).toMatchObject({
        ok: false,
        problems: {birthDate: 'birth-date-format'},
      });
    }
  });

  it('when the MRN holds a space or a "|" (a token system separator), then it is refused', () => {
    for (const mrn of ['TEST 1', 'sys|TEST-1', 'TEST,1']) {
      expect(parsePatientSearch({...BLANK, mrn})).toMatchObject({
        ok: false,
        problems: {mrn: 'mrn-characters'},
      });
    }
  });

  it('when several fields are wrong, then each is named', () => {
    expect(
      parsePatientSearch({name: 'x', birthDate: 'soon', mrn: 'a b'}),
    ).toEqual({
      ok: false,
      empty: false,
      problems: {
        name: 'name-too-short',
        birthDate: 'birth-date-format',
        mrn: 'mrn-characters',
      },
    });
  });
});

describe('given a parsed patient search (API-11)', () => {
  it('when page 1 is searched by name, then only name, _count and _offset are sent, one more than a page to learn whether another exists', async () => {
    const sent = answerPatientSearch();
    await searchPatients(parsed({name: 'Testperson'}), 0);

    expect(sent).toHaveLength(1);
    expect(Object.fromEntries(sent[0] ?? [])).toEqual({
      name: 'Testperson',
      _count: String(PATIENT_PAGE_SIZE + 1),
      _offset: '0',
    });
  });

  it('when all three fields are given on page 3, then name, birthdate and identifier are sent with the offset of that page', async () => {
    const sent = answerPatientSearch();
    await searchPatients(
      parsed({name: 'Te', birthDate: '1970-01-01', mrn: 'TEST-MRN-0001'}),
      2,
    );

    expect(Object.fromEntries(sent[0] ?? [])).toEqual({
      name: 'Te',
      birthdate: '1970-01-01',
      identifier: 'TEST-MRN-0001',
      _count: String(PATIENT_PAGE_SIZE + 1),
      _offset: String(2 * PATIENT_PAGE_SIZE),
    });
  });

  it('when the server returns more than a page, then one page is kept and hasMore is true (guards dropping the paging control)', async () => {
    answerPatientSearch(() =>
      HttpResponse.json(searchBundle(patients(PATIENT_PAGE_SIZE + 1))),
    );
    const result = await searchPatients(parsed({name: 'Te'}), 0);

    expect(result.items).toHaveLength(PATIENT_PAGE_SIZE);
    expect(result.hasMore).toBe(true);
  });

  it('when the server returns a page or less, then hasMore is false', async () => {
    answerPatientSearch(() =>
      HttpResponse.json(searchBundle(patients(PATIENT_PAGE_SIZE))),
    );
    const result = await searchPatients(parsed({name: 'Te'}), 0);

    expect(result.items).toHaveLength(PATIENT_PAGE_SIZE);
    expect(result.hasMore).toBe(false);
  });

  it('when the server says more exist (a next link) on a short page, then hasMore is true and no "more not shown" item joins the rows', async () => {
    answerPatientSearch(() => {
      const bundle = searchBundle(patients(3));
      return HttpResponse.json({
        ...bundle,
        link: [
          ...(bundle.link as unknown[]),
          {relation: 'next', url: 'https://openemr.test/apis/default/fhir/X'},
        ],
      });
    });
    const result = await searchPatients(parsed({name: 'Te'}), 0);

    expect(result.items.map(item => item.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(result.hasMore).toBe(true);
  });

  it('when one entry is malformed, then it becomes a could-not-display item in place and the others survive (FR-CARD-3)', async () => {
    answerPatientSearch(() =>
      HttpResponse.json(
        searchBundle([patient(), {resourceType: 'Patient', id: 'bad id!'}]),
      ),
    );
    const result = await searchPatients(parsed({name: 'Te'}), 0);

    expect(result.items.map(item => item.kind)).toEqual([
      'ok',
      'could-not-display',
    ]);
  });

  it('when the server refuses with 403, then the error is not-authorised and neither its message nor its details carry the search term (NFR-SEC-6)', async () => {
    answerPatientSearch(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    const error: unknown = await searchPatients(
      parsed({name: CANARY}),
      0,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).failure.kind).toBe('not-authorised');
    expect((error as ApiError).failure.apiId).toBe('API-11');
    expect((error as ApiError).message).not.toContain(CANARY);
    expect(JSON.stringify((error as ApiError).failure)).not.toContain(CANARY);
  });
});
