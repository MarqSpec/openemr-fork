import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../api/query_client';
import {patient, searchBundle} from '../test/fhir_fixtures';
import {server} from '../test/msw_server';
import {createAppTheme} from '../theme/theme';
import {navigate} from './navigation';
import {Workspace} from './Workspace';

// A card that failed for one patient must not keep showing that failure on the next chart: the chart is keyed by
// the routed patient id, so every card boundary and per-patient state starts again. A throwing data hook is the one
// failure only a boundary catches, so the Problem List's hook is replaced to throw for the first patient only.
// reference: REQUIREMENTS.md FR-CARD-1

const FAILING = 'test-patient-0001';

vi.mock('../api/fhir/hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/fhir/hooks')>();
  return {
    ...actual,
    useProblems: (...args: Parameters<typeof actual.useProblems>) => {
      if (args[0] === FAILING) throw new Error('hook failure');
      return actual.useProblems(...args);
    },
  };
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

function renderWorkspace() {
  return render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme('light')}>
        <Workspace />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const problemList = () =>
  within(screen.getByRole('region', {name: 'Dashboard'})).getByRole('region', {
    name: 'Problem List',
  });

describe('given a chart whose Problem List failed to display', () => {
  it('when another patient is routed, then the new chart starts clean and its Problem List renders (guards a failure carried across patients)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    server.use(
      http.get('/bff/fhir/Patient/:id', ({params}) =>
        HttpResponse.json(
          patient({
            id: String(params.id),
            name: [
              {
                use: 'official',
                family: 'Testperson',
                given: [params.id === FAILING ? 'Fakey' : 'Other'],
              },
            ],
          }),
        ),
      ),
      http.get('/bff/fhir/:type', () => HttpResponse.json(searchBundle([]))),
    );
    window.history.replaceState(null, '', `/patient/${FAILING}`);
    renderWorkspace();

    expect(
      await screen.findByRole('heading', {level: 1, name: 'Fakey Testperson'}),
    ).toBeInTheDocument();
    expect(within(problemList()).getByRole('alert')).toHaveTextContent(
      "Couldn't display this card.",
    );

    act(() => {
      navigate('/patient/test-patient-0002');
    });

    expect(
      await screen.findByRole('heading', {level: 1, name: 'Other Testperson'}),
    ).toBeInTheDocument();
    expect(
      await within(problemList()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(
      within(problemList()).queryByText("Couldn't display this card."),
    ).toBeNull();
  });
});
