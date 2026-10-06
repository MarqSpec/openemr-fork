import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {http, HttpResponse} from 'msw';
import {useState} from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../api/query_client';
import {PATIENT_PAGE_SIZE} from '../../api/fhir/patient_search';
import {server} from '../../test/msw_server';
import {HEAVY_SUITE} from '../../test/timeouts';
import {
  CANARY,
  operationOutcome,
  patient,
  searchBundle,
} from '../../test/fhir_fixtures';
import {
  EMPTY_PATIENT_SEARCH,
  PatientSearch,
  type OpenedPatient,
  type PatientSearchState,
} from './PatientSearch';

// reference: REQUIREMENTS.md FR-PAT-1, FR-PAT-2, FR-AUTH-5, FR-CARD-3, NFR-SEC-1, NFR-SEC-6,
// NFR-A11Y-2 · INTERFACES.md API-11 · REQUIREMENTS.md W-2 · REQUIREMENTS.md BUG-7

let sent: URLSearchParams[] = [];

function answer(respond: (query: URLSearchParams) => Response): void {
  server.use(
    http.get('/bff/fhir/Patient', ({request}) => {
      const query = new URL(request.url).searchParams;
      sent.push(query);
      return respond(query);
    }),
  );
}

function patients(count: number, first = 0): unknown[] {
  return Array.from({length: count}, (_, index) =>
    patient({
      id: `test-patient-${String(first + index).padStart(4, '0')}`,
      name: [
        {
          use: 'official',
          family: 'Testperson',
          given: [`Fakey${String(first + index)}`],
        },
      ],
    }),
  );
}

function Harness({onOpen}: {readonly onOpen: (p: OpenedPatient) => void}) {
  const [state, setState] = useState<PatientSearchState>(EMPTY_PATIENT_SEARCH);
  return (
    <PatientSearch state={state} onStateChange={setState} onOpen={onOpen} />
  );
}

function renderSearch(onOpen: (p: OpenedPatient) => void = vi.fn()) {
  const client = createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0});
  render(
    <QueryClientProvider client={client}>
      <Harness onOpen={onOpen} />
    </QueryClientProvider>,
  );
}

/**
 * Puts `text` into the field as one paste. The form reads a field only through its change event and on submit, so a
 * paste reaches the same code as typing, without the re-render per character that made each search spec cost most of
 * a second and fail its 5 s on a loaded runner.
 */
async function enter(field: string, text: string): Promise<void> {
  await userEvent.click(screen.getByRole('textbox', {name: field}));
  await userEvent.paste(text);
}

async function searchByName(name: string): Promise<void> {
  await enter('Name', name);
  await userEvent.click(screen.getByRole('button', {name: 'Search'}));
}

beforeEach(() => {
  sent = [];
});

describe('given the patient search form (W-2)', () => {
  it('when it shows, then it has labelled Name, Date of birth and MRN fields and a Search button', () => {
    renderSearch();

    expect(
      screen.getByRole('heading', {level: 1, name: 'Patient search'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', {name: 'Name'})).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', {name: 'Date of birth'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', {name: 'MRN'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Search'})).toBeInTheDocument();
  });

  it('when it shows, then the browser is told not to remember what is typed (guards search terms in autofill storage, NFR-SEC-1)', () => {
    renderSearch();
    for (const name of ['Name', 'Date of birth', 'MRN']) {
      expect(screen.getByRole('textbox', {name})).toHaveAttribute(
        'autocomplete',
        'off',
      );
    }
  });

  it('when Search is pressed with every field blank, then it asks for a term and sends nothing', async () => {
    renderSearch();
    await userEvent.click(screen.getByRole('button', {name: 'Search'}));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a name, date of birth or MRN',
    );
    expect(sent).toHaveLength(0);
  });

  it('when the name has one letter, then the Name field is marked invalid, says why and takes focus, and nothing is sent (FR-PAT-1)', async () => {
    renderSearch();
    await searchByName('F');

    const name = screen.getByRole('textbox', {name: 'Name'});
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(/at least 2 letters/);
    expect(name).toHaveFocus();
    expect(sent).toHaveLength(0);
  });

  it('when the date of birth is not YYYY-MM-DD, then that field says so and nothing is sent', async () => {
    renderSearch();
    await enter('Date of birth', '01/01/1970');
    await userEvent.click(screen.getByRole('button', {name: 'Search'}));

    const dob = screen.getByRole('textbox', {name: 'Date of birth'});
    expect(dob).toHaveAttribute('aria-invalid', 'true');
    expect(dob).toHaveAccessibleDescription(/YYYY-MM-DD/);
    expect(sent).toHaveLength(0);
  });

  it('when a search runs, then the page URL does not change (guards PHI in the URL or history, FR-PAT-2)', async () => {
    answer(() => HttpResponse.json(searchBundle(patients(1))));
    const before = window.location.href;
    const entries = window.history.length;
    renderSearch();
    await searchByName(CANARY);
    await screen.findByRole('list', {name: 'Search results'});

    expect(window.location.href).toBe(before);
    expect(window.history.length).toBe(entries);
  });
});

describe('given patients match the search', () => {
  it('when results arrive, then each row shows name, date of birth, sex and MRN (FR-PAT-1)', async () => {
    answer(() => HttpResponse.json(searchBundle([patient()])));
    renderSearch();
    await searchByName('Testperson');

    const list = await screen.findByRole('list', {name: 'Search results'});
    const row = within(list).getByRole('button');
    expect(row).toHaveAccessibleName(
      'Fakey Testperson Date of birth 1970-01-01 Sex Female MRN TEST-MRN-0001',
    );
  });

  it('when a patient has an SSN identifier, then the SSN is never shown (minimum necessary, SCR-FINDER)', async () => {
    answer(() =>
      HttpResponse.json(
        searchBundle([
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
                system: 'http://hl7.org/fhir/sid/us-ssn',
                value: '999-00-0000',
              },
            ],
          }),
        ]),
      ),
    );
    renderSearch();
    await searchByName('Testperson');
    await screen.findByRole('list', {name: 'Search results'});

    expect(document.body).not.toHaveTextContent('999-00-0000');
  });

  it('when date of birth, sex and MRN are missing, then each shows "—" and is announced as not recorded', async () => {
    answer(() =>
      HttpResponse.json(
        searchBundle([
          {
            resourceType: 'Patient',
            id: 'test-patient-0001',
            name: [{family: 'Testperson', given: ['Fakey']}],
          },
        ]),
      ),
    );
    renderSearch();
    await searchByName('Testperson');

    const row = within(
      await screen.findByRole('list', {name: 'Search results'}),
    ).getByRole('button');
    expect(row).toHaveAccessibleName(
      'Fakey Testperson Date of birth not recorded Sex not recorded MRN not recorded',
    );
    expect(row).toHaveTextContent('—');
  });

  it('when a row is tapped, then that patient opens by id, with the name to show (FR-PAT-2)', async () => {
    answer(() => HttpResponse.json(searchBundle([patient()])));
    const onOpen = vi.fn();
    renderSearch(onOpen);
    await searchByName('Testperson');
    const list = await screen.findByRole('list', {name: 'Search results'});
    await userEvent.click(within(list).getByRole('button'));

    expect(onOpen).toHaveBeenCalledWith({
      id: 'test-patient-0001',
      name: 'Fakey Testperson',
    });
  });

  it('when one entry is malformed, then it shows as "Could not display this patient", not a tappable row (FR-CARD-3)', async () => {
    answer(() =>
      HttpResponse.json(
        searchBundle([patient(), {resourceType: 'Patient', id: 'bad id!'}]),
      ),
    );
    renderSearch();
    await searchByName('Testperson');

    const list = await screen.findByRole('list', {name: 'Search results'});
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(list).toHaveTextContent('Could not display this patient');
  });
});

// Asked for inside the pager, looked up afresh each time (a new page draws a new one): a button query across the
// whole page computes the name of every result row first.
const pager = () => screen.findByRole('navigation', {name: 'Result pages'});

describe(
  'given more than one page of patients (API-11 _count/_offset — BUG-7)',
  HEAVY_SUITE,
  () => {
    it('when Next and Previous are used, then the next and previous pages are fetched by offset and the page number follows', async () => {
      answer(query => {
        const offset = Number(query.get('_offset'));
        return HttpResponse.json(
          searchBundle(
            offset === 0
              ? patients(PATIENT_PAGE_SIZE + 1)
              : patients(3, PATIENT_PAGE_SIZE),
          ),
        );
      });
      renderSearch();
      await searchByName('Testperson');

      const list = await screen.findByRole('list', {name: 'Search results'});
      expect(within(list).getAllByRole('button')).toHaveLength(
        PATIENT_PAGE_SIZE,
      );
      expect(
        screen.getByText(`Page 1 · ${String(PATIENT_PAGE_SIZE)} patients`),
      ).toBeVisible();
      expect(
        within(await pager()).getByRole('button', {name: 'Previous page'}),
      ).toBeDisabled();

      await userEvent.click(
        within(await pager()).getByRole('button', {name: 'Next page'}),
      );
      expect(await screen.findByText('Page 2 · 3 patients')).toBeVisible();
      expect(sent.at(-1)?.get('_offset')).toBe(String(PATIENT_PAGE_SIZE));
      expect(
        within(await pager()).getByRole('button', {name: 'Next page'}),
      ).toBeDisabled();

      await userEvent.click(
        within(await pager()).getByRole('button', {name: 'Previous page'}),
      );
      expect(
        await screen.findByText(
          `Page 1 · ${String(PATIENT_PAGE_SIZE)} patients`,
        ),
      ).toBeVisible();
    });

    it('when a new search is run from page 2, then it starts again at page 1', async () => {
      answer(query =>
        HttpResponse.json(
          searchBundle(
            query.get('_offset') === '0'
              ? patients(PATIENT_PAGE_SIZE + 1)
              : patients(1, PATIENT_PAGE_SIZE),
          ),
        ),
      );
      renderSearch();
      await searchByName('Testperson');
      await userEvent.click(
        within(await pager()).getByRole('button', {name: 'Next page'}),
      );
      await screen.findByText('Page 2 · 1 patient');

      await userEvent.click(screen.getByRole('button', {name: 'Search'}));
      expect(
        await screen.findByText(
          `Page 1 · ${String(PATIENT_PAGE_SIZE)} patients`,
        ),
      ).toBeVisible();
    });
  },
);

describe('given the search does not return patients', () => {
  it('when nobody matches, then it says so', async () => {
    answer(() => HttpResponse.json(searchBundle([])));
    renderSearch();
    await searchByName('Testperson');

    expect(await screen.findByText('No patients match')).toBeVisible();
    expect(screen.queryByRole('list', {name: 'Search results'})).toBeNull();
  });

  it('when a one-word name matches nobody, then it does not suggest searching one name at a time', async () => {
    answer(() => HttpResponse.json(searchBundle([])));
    renderSearch();
    await searchByName('Testperson');

    expect(await screen.findByText('No patients match')).toBeVisible();
    expect(screen.queryByText(/one name at a time/)).toBeNull();
  });

  it('when a name with a space matches nobody, then it says to search one name at a time (guards a false "not registered" for a full name, PRD Q-3)', async () => {
    answer(() => HttpResponse.json(searchBundle([])));
    renderSearch();
    await searchByName('Fakey Testperson');

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('No patients match');
    expect(status).toHaveTextContent(
      'OpenEMR matches the name against one name at a time. Search one name, e.g. the surname.',
    );
  });

  it('when a name with a space matches a patient, then the results show with no advice (spaces stay legal: Van Der Berg, Mary Ann)', async () => {
    answer(() => HttpResponse.json(searchBundle([patient()])));
    renderSearch();
    await searchByName('Van Der Berg');

    expect(
      await screen.findByRole('list', {name: 'Search results'}),
    ).toBeVisible();
    expect(screen.queryByText(/one name at a time/)).toBeNull();
    expect(sent.at(-1)?.get('name')).toBe('Van Der Berg');
  });

  it('when the form shows, then the Name hint says to search one name (PRD Q-3)', () => {
    renderSearch();
    expect(
      screen.getByRole('textbox', {name: 'Name'}),
    ).toHaveAccessibleDescription(
      'One name: the start of a surname or given name',
    );
  });

  it('when the server answers 403, then it shows "Not authorised to search patients" with no retry (FR-AUTH-5)', async () => {
    answer(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    renderSearch();
    await searchByName('Testperson');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not authorised to search patients',
    );
    expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull();
  });

  it('when the server fails, then an error with "Try again" shows, and trying again succeeds', async () => {
    answer(() =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );
    renderSearch();
    await searchByName('Testperson');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't search patients",
    );
    answer(() => HttpResponse.json(searchBundle([patient()])));
    await userEvent.click(screen.getByRole('button', {name: 'Try again'}));

    expect(
      await screen.findByRole('list', {name: 'Search results'}),
    ).toBeVisible();
  });

  it('when the search fails, then the error text never repeats what was searched for (NFR-SEC-6)', async () => {
    answer(() =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );
    renderSearch();
    await searchByName(CANARY);

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(CANARY);
  });
});
