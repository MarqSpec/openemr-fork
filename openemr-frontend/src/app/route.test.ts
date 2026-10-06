import {describe, expect, it} from 'vitest';

import {parseRoute, patientPath} from './route';

// reference: REQUIREMENTS.md FR-PAT-2 (a dashboard opens by patient logical id; nothing
// identifying in the URL)

describe('given a URL path', () => {
  it("when it is /patient/<id>, then it opens that patient's dashboard", () => {
    expect(parseRoute('/patient/test-patient-0001')).toEqual({
      kind: 'patient',
      patientId: 'test-patient-0001',
    });
  });

  it('when it has a trailing slash, then it opens the same dashboard', () => {
    expect(parseRoute('/patient/test-patient-0001/')).toEqual({
      kind: 'patient',
      patientId: 'test-patient-0001',
    });
  });

  it.each(['/', '/patient', '/patient/', '/patient/a/b', '/other/x', ''])(
    'when it is %j, then it is the home screen (guards a stray path opening a chart)',
    path => {
      expect(parseRoute(path)).toEqual({kind: 'home'});
    },
  );

  it('when the id is not valid percent-encoding, then it is the home screen, not a crash', () => {
    expect(parseRoute('/patient/%E0%A4%A')).toEqual({kind: 'home'});
  });
});

describe('given a patient id', () => {
  it('when its dashboard path is built, then it round-trips through the parser', () => {
    expect(parseRoute(patientPath('test-patient-0001'))).toEqual({
      kind: 'patient',
      patientId: 'test-patient-0001',
    });
  });
});
