import {describe, expect, it} from 'vitest';

import type {Patient} from '../../api/fhir/schemas';
import {
  ageOn,
  displayName,
  mrnOf,
  patientStatus,
  sexLabel,
} from './patient_format';

// reference: REQUIREMENTS.md FR-HDR-1…3 · INTERFACES.md API-12 · REQUIREMENTS.md BUG-6

const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const BIRTHSEX =
  'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex';

function patient(fields: Partial<Patient> = {}): Patient {
  return {resourceType: 'Patient', id: 'test-patient-0001', ...fields};
}

describe('given a date of birth, when the age is computed on a given day', () => {
  it('then the day before the birthday is one year younger than the birthday itself', () => {
    expect(ageOn('1970-06-15', '2026-06-14')).toBe(55);
    expect(ageOn('1970-06-15', '2026-06-15')).toBe(56);
  });

  it('then a birth later the same year is still age 0', () => {
    expect(ageOn('2026-01-01', '2026-09-25')).toBe(0);
  });

  it('then a leap-day birth has its birthday on 1 March in a common year (not a day early)', () => {
    expect(ageOn('2000-02-29', '2025-02-28')).toBe(24);
    expect(ageOn('2000-02-29', '2025-03-01')).toBe(25);
  });

  it('then a leap-day birth has its birthday on 29 February in a leap year', () => {
    expect(ageOn('2000-02-29', '2024-02-28')).toBe(23);
    expect(ageOn('2000-02-29', '2024-02-29')).toBe(24);
  });

  it('then a partial date of birth (year or year-month) gives no age rather than a guess', () => {
    expect(ageOn('1970', '2026-09-25')).toBeUndefined();
    expect(ageOn('1970-06', '2026-09-25')).toBeUndefined();
  });

  it('then a missing date of birth gives no age', () => {
    expect(ageOn(undefined, '2026-09-25')).toBeUndefined();
  });

  it('then a date of birth after the day gives no age rather than a negative one', () => {
    expect(ageOn('2027-01-01', '2026-09-25')).toBeUndefined();
  });

  it('then a dateTime as the day (date of death) counts only its calendar date, as recorded', () => {
    expect(ageOn('1958-03-14', '2026-03-13T23:30:00-05:00')).toBe(67);
    expect(ageOn('1958-03-14', '2026-03-14T00:10:00+10:00')).toBe(68);
  });
});

describe('given a patient name', () => {
  it('when there is an official name, then it shows given names then family name', () => {
    expect(
      displayName([
        {use: 'usual', given: ['Jo'], family: 'Sample'},
        {use: 'official', given: ['Jordan', 'Q.'], family: 'Sample'},
      ]),
    ).toBe('Jordan Q. Sample');
  });

  it('when there is no official name, then the usual name is used, and an old name never is', () => {
    expect(
      displayName([
        {use: 'old', given: ['Former'], family: 'Name'},
        {use: 'usual', given: ['Jo'], family: 'Sample'},
      ]),
    ).toBe('Jo Sample');
    expect(
      displayName([{use: 'old', given: ['Former'], family: 'Name'}]),
    ).toBeUndefined();
  });

  it('when only the family name is recorded, then it shows the family name', () => {
    expect(displayName([{family: 'Sample'}])).toBe('Sample');
  });

  it('when only a text name is recorded, then it shows the text', () => {
    expect(displayName([{text: 'Jordan Sample'}])).toBe('Jordan Sample');
  });

  it('when the name is absent or blank, then there is no name', () => {
    expect(displayName(undefined)).toBeUndefined();
    expect(displayName([])).toBeUndefined();
    expect(displayName([{given: ['  '], family: ''}])).toBeUndefined();
  });
});

describe('given a patient sex', () => {
  it.each([
    ['female', 'Female'],
    ['male', 'Male'],
    ['other', 'Other'],
    ['unknown', 'Unknown'],
  ] as const)('when gender is %s, then it shows %s', (gender, label) => {
    expect(sexLabel(patient({gender}))).toBe(label);
  });

  it('when gender is absent but US Core birth sex is recorded, then birth sex is shown', () => {
    expect(
      sexLabel(patient({extension: [{url: BIRTHSEX, valueCode: 'M'}]})),
    ).toBe('Male');
  });

  it('when neither is recorded, then there is no sex', () => {
    expect(sexLabel(patient())).toBeUndefined();
  });
});

describe('given patient identifiers, when the MRN is picked', () => {
  it('then it is the identifier typed v2-0203|PT, not the first identifier', () => {
    expect(
      mrnOf([
        {
          type: {coding: [{system: V2_0203, code: 'SS'}]},
          value: '000-00-0000',
        },
        {type: {coding: [{system: V2_0203, code: 'PT'}]}, value: 'TEST-MRN-1'},
      ]),
    ).toBe('TEST-MRN-1');
  });

  it('then a PT code from another system is not an MRN', () => {
    expect(
      mrnOf([
        {
          type: {coding: [{system: 'urn:other', code: 'PT'}]},
          value: 'TEST-MRN-X',
        },
      ]),
    ).toBeUndefined();
  });

  it('then a PT identifier without a value is not an MRN', () => {
    expect(
      mrnOf([{type: {coding: [{system: V2_0203, code: 'PT'}]}, value: ' '}]),
    ).toBeUndefined();
  });

  it('then a blank PT identifier is skipped and a later PT identifier with a value is the MRN', () => {
    expect(
      mrnOf([
        {type: {coding: [{system: V2_0203, code: 'PT'}]}, value: ' '},
        {type: {coding: [{system: V2_0203, code: 'PT'}]}},
        {type: {coding: [{system: V2_0203, code: 'PT'}]}, value: 'TEST-MRN-2'},
      ]),
    ).toBe('TEST-MRN-2');
  });

  it('then no identifiers means no MRN', () => {
    expect(mrnOf(undefined)).toBeUndefined();
  });
});

describe('given a patient status, derived from deceased[x] only, since active merely mirrors it (BUG-6)', () => {
  it('when nothing says deceased, then the status is active, even if active is false', () => {
    expect(patientStatus(patient({active: false}))).toEqual({kind: 'active'});
    expect(patientStatus(patient({deceasedBoolean: false}))).toEqual({
      kind: 'active',
    });
  });

  it('when deceasedDateTime is set, then the status is deceased on that date', () => {
    expect(
      patientStatus(patient({deceasedDateTime: '2026-08-02T10:00:00+00:00'})),
    ).toEqual({kind: 'deceased', date: '2026-08-02'});
  });

  it('when deceasedDateTime is midnight at +14:00 or late evening at -12:00, then the date is the one OpenEMR recorded (BUG-51)', () => {
    expect(
      patientStatus(patient({deceasedDateTime: '2026-08-02T00:00:00+14:00'})),
    ).toEqual({kind: 'deceased', date: '2026-08-02'});
    expect(
      patientStatus(patient({deceasedDateTime: '2026-08-02T23:30:00-12:00'})),
    ).toEqual({kind: 'deceased', date: '2026-08-02'});
  });

  it('when only deceasedBoolean is true, then the status is deceased with no date', () => {
    expect(patientStatus(patient({deceasedBoolean: true}))).toEqual({
      kind: 'deceased',
      date: undefined,
    });
  });
});
