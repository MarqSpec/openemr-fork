import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {matchAllowListed} from './fhir_allow_list.js';

// reference: INTERFACES.md API-10…24, API-44 · REQUIREMENTS.md FR-BFF-3, FR-BFF-5
// The matcher judges the raw request target exactly as the socket delivered it. These cases are the ones an
// HTTP client (and fastify.inject) would normalise before sending, so they are tested here, not end to end.

describe('given a raw request target the injector would have normalised', () => {
  it.each([
    '/bff/fhir/Patient\\p-1',
    '/bff/fhir/Patient/p-1\\..\\..\\api',
    '/bff/fhir/../api/patient',
    '/bff/fhir/./Patient/p-1',
    '/bff/fhir/Patient/./p-1',
    '/bff/fhir/Patient/../Practitioner/p-1',
    '/bff/fhir/Patient/p-1/..',
    '/bff/fhir/Patient/p-1#frag',
    '/bff/fhir/Patient/p 1',
    '/BFF/fhir/Patient/p-1',
    '/bff/FHIR/Patient/p-1',
    'http://openemr.example.test/bff/fhir/Patient/p-1',
    '//bff/fhir/Patient/p-1',
  ])('when the target is %s, then it matches no row', raw => {
    expect(matchAllowListed(raw)).toBeUndefined();
  });
});

describe('given query parameters named after Object members', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'when a search carries %s, then it matches no row (and does not throw)',
    name => {
      expect(
        matchAllowListed(`/bff/fhir/AllergyIntolerance?patient=p-1&${name}=x`),
      ).toBeUndefined();
    },
  );
});

describe('given the Appointments card’s read (API-24)', () => {
  it('when it reads Appointment?patient={id}&date=ge{today}, then it is API-24 and only those two are forwarded', () => {
    const read = matchAllowListed(
      '/bff/fhir/Appointment?patient=p-1&date=ge2026-09-25',
    );

    expect(read?.apiId).toBe('API-24');
    expect(read?.path).toBe('Appointment');
    expect(Object.fromEntries(read?.query ?? [])).toEqual({
      patient: 'p-1',
      date: 'ge2026-09-25',
    });
  });

  it.each([
    // The card lists every future appointment, whatever its status or provider, as legacy does.
    'patient=p-1&date=ge2026-09-25&status=booked',
    'patient=p-1&date=ge2026-09-25&practitioner=pr-1',
    'patient=p-1&date=ge2026-09-25&_id=a-1',
    'patient=p-1&date=ge2026-09-25&_lastUpdated=ge2026-09-01',
    // Paging and sort do nothing on OpenEMR (BUG-7) and the card sends neither.
    'patient=p-1&date=ge2026-09-25&_count=10',
    'patient=p-1&date=ge2026-09-25&_sort=date',
    // Future only: a lower bound, one day, never an upper bound, a range or a bare date.
    'patient=p-1&date=le2026-09-25',
    'patient=p-1&date=2026-09-25',
    'patient=p-1&date=ge2026-09-25T00:00:00',
    'patient=p-1&date=ge2026-09-25&date=le2026-12-31',
    'patient=p-1',
    // `patient` exactly once, and one patient.
    'date=ge2026-09-25',
    'patient=p-1,p-2&date=ge2026-09-25',
    'patient=p-1&patient=p-2&date=ge2026-09-25',
  ])(
    'when an appointment search is "%s", then no row matches: API-24 is the Appointments card’s read and nothing wider',
    query => {
      expect(
        matchAllowListed(`/bff/fhir/Appointment?${query}`),
      ).toBeUndefined();
    },
  );

  it('when an appointment is read by id, then no row matches: the card never reads one', () => {
    expect(matchAllowListed('/bff/fhir/Appointment/a-1')).toBeUndefined();
  });
});

describe('given an allow-listed read', () => {
  it('when it matches, then the forwarded path and query are rebuilt from the validated parts only', () => {
    const read = matchAllowListed(
      '/bff/fhir/Observation?patient=p-1&category=laboratory&date=ge2025-09-25',
    );

    expect(read).toMatchObject({
      apiId: 'API-22',
      kind: 'search',
      path: 'Observation',
    });
    expect(Object.fromEntries(read?.query ?? [])).toEqual({
      patient: 'p-1',
      category: 'laboratory',
      date: 'ge2025-09-25',
    });
  });

  it('when the Vitals card reads Observation?patient&category=vital-signs&date=ge…, then it is API-21, forwarded with exactly those three parameters', () => {
    const read = matchAllowListed(
      '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25',
    );

    expect(read).toMatchObject({apiId: 'API-21', kind: 'search'});
    expect(Object.fromEntries(read?.query ?? [])).toEqual({
      patient: 'p-1',
      category: 'vital-signs',
      date: 'ge2025-09-25',
    });
  });

  it('when a vitals search narrows by code, then no row matches: the card never sends one', () => {
    expect(
      matchAllowListed(
        '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&code=8867-4',
      ),
    ).toBeUndefined();
  });

  it('when the Medications or the Prescriptions card reads MedicationRequest?patient={id}, then it is one shared row, named for both', () => {
    // The two cards send the same request; the proxy cannot tell which one did, so it does not pretend to.
    expect(
      matchAllowListed('/bff/fhir/MedicationRequest?patient=p-1')?.apiId,
    ).toBe('API-15/16');
  });

  it('when MedicationRequest carries an intent or a status, then no row matches: the shared row is patient-only, every intent (rulings)', () => {
    for (const query of [
      'patient=p-1&intent=plan',
      'patient=p-1&intent=order',
      'patient=p-1&intent=order&status=active',
      'intent=order&patient=p-1&status=completed',
      'patient=p-1&status=active',
    ]) {
      expect(
        matchAllowListed(`/bff/fhir/MedicationRequest?${query}`),
      ).toBeUndefined();
    }
  });

  it('when a patient search carries a space-separated name, then it matches API-11', () => {
    expect(matchAllowListed('/bff/fhir/Patient?name=Mary+Ann')?.apiId).toBe(
      'API-11',
    );
  });

  it('when the Labs card reads Observation?patient&category=laboratory&date=ge…, then it is API-22, in any parameter order', () => {
    expect(
      matchAllowListed(
        '/bff/fhir/Observation?date=ge2025-09-25&category=laboratory&patient=p-1',
      )?.apiId,
    ).toBe('API-22');
  });

  it.each([
    // The card shows the latest result of every test, so it never narrows by code.
    'patient=p-1&category=laboratory&date=ge2025-09-25&code=2345-7',
    'patient=p-1&category=laboratory&date=ge2025-09-25&code=http%3A%2F%2Floinc.org%7C2345-7',
    // Paging and sort do nothing on OpenEMR (BUG-7) and the card sends neither.
    'patient=p-1&category=laboratory&date=ge2025-09-25&_count=50',
    'patient=p-1&category=laboratory&date=ge2025-09-25&_sort=-date',
    // `patient` exactly once, and one patient: never a list, never missing.
    'category=laboratory&date=ge2025-09-25',
    'patient=p-1&patient=p-2&category=laboratory&date=ge2025-09-25',
    'patient=p-1,p-2&category=laboratory&date=ge2025-09-25',
    'patient=&category=laboratory&date=ge2025-09-25',
    // The date is always a lower bound, and always sent: without it OpenEMR returns the whole history (BUG-36).
    'patient=p-1&category=laboratory',
    'patient=p-1&category=laboratory&date=le2025-09-25',
    'patient=p-1&category=laboratory&date=ge2025-09-25&date=ge2020-01-01',
    'patient=p-1&category=laboratory&category=vital-signs&date=ge2025-09-25',
  ])(
    'when a lab search is %s, then no row matches: API-22 is the Labs card’s read and nothing wider',
    query => {
      expect(
        matchAllowListed(`/bff/fhir/Observation?${query}`),
      ).toBeUndefined();
    },
  );
});

describe('given nothing may be kept (FR-BFF-5)', () => {
  it.each(['fhir_proxy.ts', 'fhir_allow_list.ts', 'upstream_limiter.ts'])(
    'when %s is read, then it imports nothing that can touch the file system',
    file => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).not.toMatch(/from 'node:fs|from 'fs|require\(/);
    },
  );
});

describe('given the Immunizations card’s read (API-23)', () => {
  it('when it reads Immunization?patient={id}, then it is API-23 and the patient is forwarded alone', () => {
    const read = matchAllowListed('/bff/fhir/Immunization?patient=p-1');

    expect(read?.apiId).toBe('API-23');
    expect(read?.path).toBe('Immunization');
    expect(Object.fromEntries(read?.query ?? [])).toEqual({patient: 'p-1'});
  });

  it.each([
    // The card lists every immunization, as legacy does: no filter it does not send.
    'patient=p-1&_id=i-1',
    'patient=p-1&_lastUpdated=ge2025-09-25',
    'patient=p-1&date=ge2025-09-25',
    'patient=p-1&status=completed',
    // Paging and sort do nothing on OpenEMR (BUG-7) and the card sends neither.
    'patient=p-1&_count=50',
    'patient=p-1&_sort=-date',
    // `patient` exactly once, and one patient: never a list, never missing.
    '',
    '_id=i-1',
    'patient=p-1&patient=p-2',
    'patient=p-1,p-2',
    'patient=',
  ])(
    'when an immunization search is "%s", then no row matches: API-23 is the Immunizations card’s read and nothing wider',
    query => {
      expect(
        matchAllowListed(`/bff/fhir/Immunization?${query}`),
      ).toBeUndefined();
    },
  );

  it('when an immunization is read by id, then no row matches: the card never reads one', () => {
    expect(matchAllowListed('/bff/fhir/Immunization/i-1')).toBeUndefined();
  });
});
