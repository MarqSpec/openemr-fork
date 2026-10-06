import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react';
import {delay, http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import type {Practitioner} from '../../api/fhir/schemas';
import {createQueryClient} from '../../api/query_client';
import {
  CANARY,
  operationOutcome,
  organization,
  practitioner,
} from '../../test/fhir_fixtures';
import {server} from '../../test/msw_server';
import {createAppTheme} from '../../theme/theme';
import {ReferenceName, type ReferenceNameProps} from './ReferenceName';

// reference: REQUIREMENTS.md NFR-PERF-3, FR-CARD-CT-1, FR-CARD-ENC-1, FR-CARD-RX-1 ·
// INTERFACES.md API-18, API-19 · REQUIREMENTS.md BUG-10 · REQUIREMENTS.md W-5

interface Answers {
  readonly practitioner?: () => Response | Promise<Response>;
  readonly organization?: () => Response | Promise<Response>;
}

interface Reads {
  practitioner: string[];
  organization: string[];
}

function answer(answers: Answers = {}): Reads {
  const reads: Reads = {practitioner: [], organization: []};
  server.use(
    http.get('/bff/fhir/Practitioner/:id', ({params}) => {
      reads.practitioner.push(String(params.id));
      return answers.practitioner?.() ?? HttpResponse.json(practitioner());
    }),
    http.get('/bff/fhir/Organization/:id', ({params}) => {
      reads.organization.push(String(params.id));
      return answers.organization?.() ?? HttpResponse.json(organization());
    }),
  );
  return reads;
}

function newClient(): QueryClient {
  return createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0});
}

const BOTH = ['Practitioner', 'Organization'] as const;

function renderName(
  props: Partial<ReferenceNameProps> & Pick<ReferenceNameProps, 'reference'>,
  client: QueryClient = newClient(),
) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme('light')}>
        <p aria-label="Shown name">
          <ReferenceName readable={BOTH} what="member" {...props} />
        </p>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const shown = () => screen.getByLabelText('Shown name');

/** The cell's text once no name is loading. */
async function settled(): Promise<string | null> {
  await vi.waitFor(() => {
    expect(shown()).not.toHaveTextContent(/Loading/);
  });
  return shown().textContent;
}

describe('given a reference that carries its own display', () => {
  it('when it is shown, then that name is used and nothing is read (NFR-PERF-3)', async () => {
    const reads = answer();
    renderName({
      reference: {
        reference: 'Practitioner/test-practitioner-0001',
        display: '  Displayed Testname  ',
      },
    });

    expect(await settled()).toBe('Displayed Testname');
    expect(reads).toEqual({practitioner: [], organization: []});
  });

  it('when the display is only whitespace, then the name is read instead (guards a blank name shown as a name)', async () => {
    const reads = answer();
    renderName({
      reference: {
        reference: 'Practitioner/test-practitioner-0001',
        display: '   ',
      },
    });

    expect(await settled()).toBe('Fakedoc Testdoctor');
    expect(reads.practitioner).toEqual(['test-practitioner-0001']);
  });
});

describe('given a Practitioner reference (API-18)', () => {
  it('while the name loads, then it says which name is loading and is busy, and never blocks the row', async () => {
    answer({
      practitioner: async () => {
        await delay('infinite');
        return HttpResponse.json(practitioner());
      },
    });
    renderName({
      reference: {reference: 'Practitioner/test-practitioner-0001'},
      what: 'prescriber',
    });

    const loading = await screen.findByText('Loading prescriber name…');
    expect(loading.closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('when the read succeeds, then the practitioner is named as the patient header names people', async () => {
    const reads = answer();
    renderName({reference: {reference: 'Practitioner/test-practitioner-0001'}});

    expect(await settled()).toBe('Fakedoc Testdoctor');
    expect(reads.practitioner).toEqual(['test-practitioner-0001']);
  });

  it('when the card names practitioners its own way, then that way is used', async () => {
    answer();
    const lastFirst = (resource: Practitioner) =>
      `${resource.name?.[0]?.family ?? ''}, ${resource.name?.[0]?.given?.[0] ?? ''}`;
    renderName({
      reference: {reference: 'Practitioner/test-practitioner-0001'},
      practitionerName: lastFirst,
    });

    expect(await settled()).toBe('Testdoctor, Fakedoc');
  });

  it('when the practitioner has no name, then it reads "Name unavailable" (W-5)', async () => {
    answer({practitioner: () => HttpResponse.json(practitioner({name: []}))});
    renderName({reference: {reference: 'Practitioner/test-practitioner-0001'}});

    expect(await settled()).toBe('Name unavailable');
  });

  it('when the practitioner does not parse, then it reads "Name unavailable" (W-5)', async () => {
    answer({
      practitioner: () => HttpResponse.json(practitioner({id: 42})),
    });
    renderName({reference: {reference: 'Practitioner/test-practitioner-0001'}});

    expect(await settled()).toBe('Name unavailable');
  });
});

describe('given an Organization reference (API-19)', () => {
  it('when the read succeeds, then the facility name is shown', async () => {
    const reads = answer();
    renderName({
      reference: {reference: 'Organization/test-org-0001'},
      what: 'facility',
    });

    expect(await settled()).toBe('Test Clinic');
    expect(reads.organization).toEqual(['test-org-0001']);
  });

  it('when the organization name is blank, then it reads "Name unavailable" (W-5)', async () => {
    answer({organization: () => HttpResponse.json(organization({name: ' '}))});
    renderName({reference: {reference: 'Organization/test-org-0001'}});

    expect(await settled()).toBe('Name unavailable');
  });
});

describe('given a reference the card may not or cannot read', () => {
  it.each([
    [
      'an Organization where only practitioners are read (a prescriber without an NPI)',
      {reference: 'Organization/test-org-0001'},
      ['Practitioner'] as const,
    ],
    [
      'a type with no read in the inventory (a related person)',
      {reference: 'RelatedPerson/test-related-0001'},
      BOTH,
    ],
    ['a type only, with no reference', {type: 'Practitioner'}, BOTH],
    [
      'an id FHIR does not allow',
      {reference: 'Practitioner/test practitioner'},
      BOTH,
    ],
    ['a dot-segment id', {reference: 'Practitioner/..'}, BOTH],
    [
      'a nested path',
      {reference: 'Practitioner/test-practitioner-0001/_history/1'},
      BOTH,
    ],
    [
      'an absolute URL',
      {
        reference:
          'https://openemr.test/fhir/Practitioner/test-practitioner-0001',
      },
      BOTH,
    ],
  ])(
    'when it is %s, then it reads "Name unavailable" and nothing is read',
    async (_case, reference, readable) => {
      const reads = answer();
      renderName({reference, readable});

      expect(await settled()).toBe('Name unavailable');
      expect(reads).toEqual({practitioner: [], organization: []});
    },
  );
});

describe('given names OpenEMR will not give (BUG-10, W-5)', () => {
  it('when the read is refused (403), then it reads "Name unavailable" and nothing of the refusal is shown', async () => {
    answer({
      practitioner: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderName({reference: {reference: 'Practitioner/test-practitioner-0001'}});

    expect(await settled()).toBe('Name unavailable');
    expect(shown()).not.toHaveTextContent(CANARY);
  });

  it.each([
    ['refused (403)', 403, 'forbidden', 1],
    ['failing on the server (500, retried once)', 500, 'exception', 2],
  ])(
    'when the read is %s and a card showing the same name mounts again later in the session, then it is not requested again (NFR-PERF-3)',
    async (_case, status, code, firstReads) => {
      const reads = answer({
        practitioner: () => HttpResponse.json(operationOutcome(code), {status}),
        organization: () => HttpResponse.json(operationOutcome(code), {status}),
      });
      const client = newClient();
      const first = renderName(
        {reference: {reference: 'Practitioner/test-practitioner-0001'}},
        client,
      );
      expect(await settled()).toBe('Name unavailable');
      first.unmount();
      const facility = renderName(
        {reference: {reference: 'Organization/test-org-0001'}},
        client,
      );
      expect(await settled()).toBe('Name unavailable');
      facility.unmount();

      renderName(
        {reference: {reference: 'Practitioner/test-practitioner-0001'}},
        client,
      );
      expect(await settled()).toBe('Name unavailable');
      renderName(
        {reference: {reference: 'Organization/test-org-0001'}},
        client,
      );

      await vi.waitFor(() => {
        expect(screen.getAllByText('Name unavailable')).toHaveLength(2);
      });
      expect(reads.practitioner).toHaveLength(firstReads);
      expect(reads.organization).toHaveLength(firstReads);
    },
  );
});

describe('given one name in several places (NFR-PERF-3)', () => {
  it('when two rows show the same practitioner, then it is read once', async () => {
    const reads = answer();
    render(
      <QueryClientProvider client={newClient()}>
        <p>
          <ReferenceName
            reference={{reference: 'Practitioner/test-practitioner-0001'}}
            readable={BOTH}
            what="member"
          />
        </p>
        <p>
          <ReferenceName
            reference={{reference: 'Practitioner/test-practitioner-0001'}}
            readable={BOTH}
            what="member"
          />
        </p>
      </QueryClientProvider>,
    );

    expect(await screen.findAllByText('Fakedoc Testdoctor')).toHaveLength(2);
    expect(reads.practitioner).toEqual(['test-practitioner-0001']);
  });
});
