import {ThemeProvider} from '@mui/material/styles';
import type {QueryClient} from '@tanstack/react-query';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../api/query_client';
import {blockingAxeViolations} from '../../test/axe';
import {
  TEST_PATIENT_ID,
  operationOutcome,
  patient,
} from '../../test/fhir_fixtures';
import {server} from '../../test/msw_server';
import {createAppTheme} from '../../theme/theme';
import {PatientHeader} from './PatientHeader';

// reference: REQUIREMENTS.md FR-HDR-1…4, FR-AUTH-5, FR-CARD-3, NFR-A11Y-1 · INTERFACES.md
// API-12 · REQUIREMENTS.md BUG-6, BUG-61 · REQUIREMENTS.md W-3, W-12c (the name is the page's h1)

/** 2026-09-25, mid-afternoon local time: every age below is computed on this day. */
const TODAY = () => new Date(2026, 8, 25, 15, 0);

const PATIENT_PATH = `/bff/fhir/Patient/${TEST_PATIENT_ID}`;

/** Answers the Patient read in turn with `responses`, the last one repeating. */
function answerPatient(...responses: readonly (() => Response)[]) {
  let calls = 0;
  server.use(
    http.get(PATIENT_PATH, () => {
      const respond = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (respond === undefined) throw new Error('no response configured');
      return respond();
    }),
  );
  return {count: () => calls};
}

function renderHeader(
  onSessionOver = vi.fn(),
  client: QueryClient = createQueryClient({onSessionOver, retryDelayMs: 0}),
  mode: 'light' | 'dark' = 'light',
) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme(mode)}>
        <PatientHeader patientId={TEST_PATIENT_ID} clock={TODAY} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** The region the header lives in, once the patient has loaded. */
async function loadedHeader(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', {name: 'Patient'});
  await within(region).findByRole('heading', {level: 1});
  return region;
}

/** The `definition` paired with the `term` whose text is `term` (the header's facts are a description list). */
function fact(region: HTMLElement, term: string): HTMLElement {
  const terms = within(region).getAllByRole('term');
  const definitions = within(region).getAllByRole('definition');
  const index = terms.findIndex(t => t.textContent === term);
  const definition = definitions[index];
  if (index < 0 || definition === undefined) {
    throw new Error(`no fact named ${term}`);
  }
  return definition;
}

describe('given a living patient with every field recorded', () => {
  it('when the header loads, then it shows the name as the page heading, DOB with age, sex and MRN (FR-HDR-1)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    renderHeader();
    const region = await loadedHeader();

    expect(
      within(region).getByRole('heading', {level: 1, name: 'Fakey Testperson'}),
    ).toBeInTheDocument();
    expect(fact(region, 'DOB')).toHaveTextContent('1970-01-01 (age 56)');
    expect(fact(region, 'Sex')).toHaveTextContent('Female');
    expect(fact(region, 'MRN')).toHaveTextContent('TEST-MRN-0001');
  });

  it('when the header loads, then its status is a text label saying active as reported by OpenEMR, not a colour alone (FR-HDR-1, BUG-6)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    renderHeader();
    const region = await loadedHeader();

    expect(fact(region, 'Status')).toHaveTextContent(
      'Active (as reported by OpenEMR)',
    );
    expect(within(region).queryByText(/Deceased/)).not.toBeInTheDocument();
  });

  it('when the header loads, then it stays pinned while the cards scroll (FR-HDR-1)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    renderHeader();
    const region = await loadedHeader();

    expect(region).toHaveStyle({position: 'sticky'});
  });

  it('when the MRN is not the first identifier, then the one typed v2-0203|PT is shown (API-12)', async () => {
    answerPatient(() =>
      HttpResponse.json(
        patient({
          identifier: [
            {
              type: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                    code: 'SS',
                  },
                ],
              },
              value: 'TEST-SSN-0000',
            },
            {
              type: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                    code: 'PT',
                  },
                ],
              },
              value: 'TEST-MRN-0002',
            },
          ],
        }),
      ),
    );
    renderHeader();
    const region = await loadedHeader();

    expect(fact(region, 'MRN')).toHaveTextContent('TEST-MRN-0002');
    expect(within(region).queryByText(/TEST-SSN/)).not.toBeInTheDocument();
  });

  it('when axe scans the header, then it finds no serious or critical WCAG violations (NFR-A11Y-1)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    const {container} = renderHeader();
    await loadedHeader();

    expect(await blockingAxeViolations(container)).toEqual([]);
  });
});

describe('given a deceased patient with a date of death (FR-HDR-2)', () => {
  const deceased = () =>
    HttpResponse.json(patient({deceasedDateTime: '2026-08-02T10:00:00+00:00'}));

  it('when the header loads, then the status says Deceased with the date and the age at death, and not Active', async () => {
    answerPatient(deceased);
    renderHeader();
    const region = await loadedHeader();

    const status = fact(region, 'Status');
    expect(status).toHaveTextContent('Deceased 2026-08-02 · age at death 56');
    expect(status).not.toHaveTextContent('Active');
  });

  it('when axe scans the header, then it finds no serious or critical WCAG violations', async () => {
    answerPatient(deceased);
    const {container} = renderHeader();
    await loadedHeader();

    expect(await blockingAxeViolations(container)).toEqual([]);
  });
});

describe('given a patient who died long ago, so the age today and the age at death differ (FR-HDR-2, review of !107)', () => {
  const longDead = () =>
    HttpResponse.json(
      patient({birthDate: '1950-01-01', deceasedDateTime: '2020-01-01'}),
    );

  it('when the header loads, then the DOB line gives the age at death, never an age today the patient never reached', async () => {
    answerPatient(longDead);
    renderHeader();
    const region = await loadedHeader();

    expect(fact(region, 'DOB')).toHaveTextContent(
      /^1950-01-01 \(age at death 70\)$/,
    );
    expect(region).not.toHaveTextContent(/76/);
    expect(fact(region, 'Status')).toHaveTextContent(
      'Deceased 2020-01-01 · age at death 70',
    );
  });
});

describe('given a patient marked deceased with no date (deceasedBoolean)', () => {
  it('when the header loads, then no age is shown anywhere: the age at death on the DOB line is "—" with an accessible label (FR-HDR-2, FR-HDR-3)', async () => {
    answerPatient(() => HttpResponse.json(patient({deceasedBoolean: true})));
    renderHeader();
    const region = await loadedHeader();

    const dob = fact(region, 'DOB');
    expect(dob).toHaveTextContent('1970-01-01 (age at death');
    expect(
      within(dob).getByText('Age at death not recorded'),
    ).toBeInTheDocument();
    expect(within(dob).getByText('—')).toHaveAttribute('aria-hidden', 'true');
    expect(region).not.toHaveTextContent(/\bage 56\b/);
  });

  it('when the header loads, then it says Deceased, and the date of death is "—" with an accessible label (FR-HDR-2, FR-HDR-3)', async () => {
    answerPatient(() => HttpResponse.json(patient({deceasedBoolean: true})));
    renderHeader();
    const region = await loadedHeader();

    const status = fact(region, 'Status');
    expect(status).toHaveTextContent('Deceased');
    expect(
      within(status).getByText('Date of death not recorded'),
    ).toBeInTheDocument();
    for (const dash of within(status).getAllByText('—')) {
      expect(dash).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('when a screen reader reads the header, then it hears "Age at death not recorded" once, not on both the DOB line and the chip (review of !107)', async () => {
    answerPatient(() => HttpResponse.json(patient({deceasedBoolean: true})));
    renderHeader();
    const region = await loadedHeader();

    expect(
      within(region).getAllByText('Age at death not recorded'),
    ).toHaveLength(1);
    expect(fact(region, 'Status')).not.toHaveTextContent(/age at death/i);
  });
});

describe('given a deceased patient whose date of birth is only a year (review of !107)', () => {
  const partialBirth = () =>
    HttpResponse.json(
      patient({birthDate: '1950', deceasedDateTime: '2020-01-01'}),
    );

  it('when the header loads, then the missing age at death is put down to the partial date of birth, not to an unrecorded one', async () => {
    answerPatient(partialBirth);
    renderHeader();
    const region = await loadedHeader();

    const dob = fact(region, 'DOB');
    expect(dob).toHaveTextContent('1950 (age at death');
    expect(
      within(dob).getByText('Age at death unknown: date of birth is partial'),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText('Age at death not recorded'),
    ).not.toBeInTheDocument();
  });

  it('when the header loads, then the chip gives the date of death and leaves the unknown age to the DOB line', async () => {
    answerPatient(partialBirth);
    renderHeader();
    const region = await loadedHeader();

    const status = fact(region, 'Status');
    expect(status).toHaveTextContent(/^Deceased 2020-01-01$/);
  });
});

describe('given a patient with no name, DOB, sex or MRN recorded (FR-HDR-3)', () => {
  const bare = () =>
    HttpResponse.json(
      patient({
        name: undefined,
        birthDate: undefined,
        gender: undefined,
        extension: undefined,
        identifier: undefined,
      }),
    );

  it('when the header loads, then each missing field shows "—" visibly and names what is missing to assistive tech', async () => {
    answerPatient(bare);
    renderHeader();
    const region = await loadedHeader();

    expect(
      within(region).getByRole('heading', {
        level: 1,
        name: 'Name not recorded',
      }),
    ).toBeInTheDocument();
    expect(
      within(fact(region, 'DOB')).getByText('Date of birth not recorded'),
    ).toBeInTheDocument();
    expect(
      within(fact(region, 'Sex')).getByText('Sex not recorded'),
    ).toBeInTheDocument();
    expect(
      within(fact(region, 'MRN')).getByText('MRN not recorded'),
    ).toBeInTheDocument();

    const dashes = within(region).getAllByText('—');
    expect(dashes).toHaveLength(4);
    for (const dash of dashes) {
      expect(dash).toBeVisible();
      expect(dash).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('when axe scans the header, then it finds no serious or critical WCAG violations', async () => {
    answerPatient(bare);
    const {container} = renderHeader();
    await loadedHeader();

    expect(await blockingAxeViolations(container)).toEqual([]);
  });

  it('when only the year of birth is recorded, then the DOB shows the year and no guessed age', async () => {
    answerPatient(() => HttpResponse.json(patient({birthDate: '1970'})));
    renderHeader();
    const region = await loadedHeader();

    expect(fact(region, 'DOB')).toHaveTextContent(/^1970$/);
  });
});

describe('given any patient, the photo slot (FR-HDR-4, deferred: BUG-61)', () => {
  const SILHOUETTE = 'Photo not shown';

  afterEach(() => {
    server.events.removeAllListeners('request:start');
  });

  /** Every request's path, in order, from the moment it is called. */
  function recordRequests(): string[] {
    const paths: string[] = [];
    server.events.on('request:start', ({request}) => {
      paths.push(new URL(request.url).pathname);
    });
    return paths;
  }

  it('when the header loads, then it shows the default silhouette, named for assistive tech, and no photograph', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    renderHeader();
    const region = await loadedHeader();

    expect(
      within(region).getByRole('img', {name: SILHOUETTE}),
    ).toBeInTheDocument();
    expect(region.querySelector('img')).toBeNull();
  });

  it('when the header loads, then the Patient read is the only request: no photo, document or Binary fetch (guards a photo read the rescope ruled out)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    const paths = recordRequests();
    renderHeader();
    await loadedHeader();

    expect(paths).toEqual([PATIENT_PATH]);
  });

  it('when the Patient resource carries a photo, then the header still shows only the silhouette and never loads the photo (no PHI drawn or cached)', async () => {
    answerPatient(() =>
      HttpResponse.json(
        patient({
          photo: [
            {contentType: 'image/png', url: 'https://example.test/photo.png'},
          ],
        }),
      ),
    );
    const paths = recordRequests();
    renderHeader();
    const region = await loadedHeader();

    expect(within(region).getAllByRole('img')).toHaveLength(1);
    expect(
      within(region).getByRole('img', {name: SILHOUETTE}),
    ).toBeInTheDocument();
    expect(document.querySelector('[src*="photo"]')).toBeNull();
    expect(paths).toEqual([PATIENT_PATH]);
  });

  it('when the patient cannot be shown (403), then no silhouette stands in for a patient who is not on screen', async () => {
    answerPatient(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    renderHeader();
    const region = await screen.findByRole('region', {name: 'Patient'});
    await within(region).findByRole('alert');

    expect(within(region).queryByRole('img')).not.toBeInTheDocument();
  });

  it('when axe scans the header with the silhouette in the dark theme, then it finds no serious or critical WCAG violations (NFR-A11Y-1)', async () => {
    answerPatient(() => HttpResponse.json(patient()));
    const {container} = renderHeader(
      vi.fn(),
      createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0}),
      'dark',
    );
    const region = await loadedHeader();
    within(region).getByRole('img', {name: SILHOUETTE});

    expect(await blockingAxeViolations(container)).toEqual([]);
  });
});

describe('given the patient read has not answered yet', () => {
  it('when the header renders, then it shows a busy placeholder that names what is loading', async () => {
    server.use(http.get(PATIENT_PATH, () => delay('infinite')));
    renderHeader();

    const region = await screen.findByRole('region', {
      name: 'Patient',
      busy: true,
    });
    expect(within(region).getByText('Loading patient…')).toBeInTheDocument();
    expect(within(region).queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('given the patient read fails', () => {
  it('when the server answers 403, then the header says the user is not authorised under an h1 "Patient unavailable", and shows no patient data (FR-AUTH-5, W-12c)', async () => {
    answerPatient(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    renderHeader();

    const region = await screen.findByRole('region', {name: 'Patient'});
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view this patient. Access is controlled in OpenEMR.",
    );
    expect(
      within(region).getByRole('heading', {
        level: 1,
        name: 'Patient unavailable',
      }),
    ).toBeInTheDocument();
  });

  it('when the server errors, then the header says so and "Try again" reloads it (guards a blank header after a transient failure)', async () => {
    const reads = answerPatient(
      () => HttpResponse.json(operationOutcome('exception'), {status: 500}),
      () => HttpResponse.json(operationOutcome('exception'), {status: 500}),
      () => HttpResponse.json(patient()),
    );
    renderHeader();

    const region = await screen.findByRole('region', {name: 'Patient'});
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Couldn't load this patient.",
    );
    expect(
      within(region).getByRole('heading', {
        level: 1,
        name: 'Patient unavailable',
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(region).getByRole('button', {name: 'Try again'}),
    );
    expect(
      await within(region).findByRole('heading', {
        level: 1,
        name: 'Fakey Testperson',
      }),
    ).toBeInTheDocument();
    expect(reads.count()).toBe(3);
  });

  it('when the patient does not parse, then the header shows "could not display" under an h1 "Patient unavailable", and no field from it (FR-CARD-3, W-12c)', async () => {
    answerPatient(() => HttpResponse.json(patient({birthDate: 'not-a-date'})));
    renderHeader();

    const region = await screen.findByRole('region', {name: 'Patient'});
    expect(
      await within(region).findByText(
        "Could not display this patient's details.",
      ),
    ).toBeInTheDocument();
    expect(within(region).queryByText(/Testperson/)).not.toBeInTheDocument();
    expect(
      within(region).getByRole('heading', {
        level: 1,
        name: 'Patient unavailable',
      }),
    ).toBeInTheDocument();
  });

  it('when the session is over (401), then the header renders nothing and leaves sign-in to the app (FR-AUTH-5)', async () => {
    answerPatient(() =>
      HttpResponse.json(operationOutcome('login'), {status: 401}),
    );
    const onSessionOver = vi.fn();
    renderHeader(onSessionOver);

    // The header draws "Loading patient…" until the 401 lands, and hands the session over before it re-renders:
    // wait for both, or a loaded runner finds the loading region still up.
    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('region')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
