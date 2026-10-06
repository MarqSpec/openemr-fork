import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {patient, searchBundle} from '../test/fhir_fixtures';
import {server} from '../test/msw_server';
import {HEAVY_SUITE} from '../test/timeouts';
import {APP_VERSION} from './version';
import {THEME_PREFERENCE_KEY} from '../theme/theme_preference';
import {App} from './App';

// reference: REQUIREMENTS.md FR-UI-2, FR-UI-3, FR-AUTH-1, FR-AUTH-3, FR-AUTH-5 ·
// REQUIREMENTS.md W-1, W-9

const SESSION_URL = '/bff/session';
let sessionReads = 0;

function answerSession(respond: () => Response) {
  server.use(
    http.get(SESSION_URL, () => {
      sessionReads += 1;
      return respond();
    }),
  );
}

const signedIn = () =>
  HttpResponse.json({
    authenticated: true,
    user: {displayName: 'Dr. Avery Demo'},
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    idleTimeoutSeconds: 900,
    grantedScopes: ['openid', 'fhirUser'],
  });

const signedOut = () =>
  HttpResponse.json({error: 'unauthenticated'}, {status: 401});

beforeEach(() => {
  sessionReads = 0;
  answerSession(signedOut);
});

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

// The menu specs look controls up inside the banner or the open menu, once, and pick a menu item by its checked state
// before its name: a named role query reads the computed style of every candidate's subtree, which jsdom does slowly
// (CONVENTIONS.md *Render-everything unit specs*).
const themeButton = () =>
  within(screen.getByRole('banner')).getByRole('button', {name: 'Theme'});

async function openThemeMenu(button: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(button);
  return screen.getByRole('menu');
}

/** Chooses a theme from the app bar as it is now drawn; a spec per session state proves the selector is wired there. */
async function chooseTheme(name: string): Promise<void> {
  await userEvent.click(
    within(await openThemeMenu(themeButton())).getByRole('menuitemradio', {
      name,
    }),
  );
}

// The menu's own behaviour is specified here with the session read left unanswered, so the page behind the bar stays
// one status line. The signed-out and signed-in describes each choose Dark once, to prove the selector is
// wired in those app bars too.
describe('given the app shell while the sign-in check is still running', () => {
  beforeEach(() => {
    server.use(http.get(SESSION_URL, () => delay('infinite')));
  });

  it('when it loads, then the app bar shows the OpenEMR logo and name', () => {
    render(<App />);
    const banner = screen.getByRole('banner');
    expect(
      within(banner).getByRole('img', {name: 'OpenEMR'}),
    ).toBeInTheDocument();
    expect(within(banner).getByText('OpenEMR')).toBeInTheDocument();
  });

  it('when the theme menu opens, then "Match device" is selected by default', async () => {
    render(<App />);
    const menu = await openThemeMenu(themeButton());

    const [light, dark, device] = within(menu).getAllByRole('menuitemradio');
    expect(light).toHaveAccessibleName('Light');
    expect(light).not.toBeChecked();
    expect(dark).toHaveAccessibleName('Dark');
    expect(dark).not.toBeChecked();
    expect(device).toHaveAccessibleName('Match device');
    expect(device).toBeChecked();
  });

  it('when the user chooses Dark, then the app switches to dark and remembers it on this device', async () => {
    render(<App />);
    const theme = themeButton();
    await userEvent.click(
      within(await openThemeMenu(theme)).getByRole('menuitemradio', {
        name: 'Dark',
      }),
    );

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('dark');

    expect(
      within(await openThemeMenu(theme)).getByRole('menuitemradio', {
        checked: true,
      }),
    ).toHaveAccessibleName('Dark');
  });

  it('when the theme menu opens, then the chosen option shows a check mark, not only a colour (NFR-A11Y-1)', async () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    render(<App />);
    const menu = await openThemeMenu(themeButton());

    const chosen = within(menu).getByRole('menuitemradio', {checked: true});
    expect(chosen).toHaveAccessibleName('Dark');
    const mark = within(chosen).getByText('✓');
    expect(mark).toBeVisible();
    expect(within(menu).getAllByText('✓')).toEqual([mark]);
  });

  it('when a Light preference was stored earlier, then the app starts light', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'light');
    render(<App />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});

describe('given nobody is signed in', () => {
  it('when the app loads, then it shows the sign-in screen (W-1) and no account button', async () => {
    render(<App />);

    expect(
      await screen.findByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('banner')).queryByRole('button', {
        name: /^Signed in/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(`Version ${APP_VERSION}`)).toBeInTheDocument();
  });

  it('when the user chooses Dark on the sign-in screen, then the app switches to dark (FR-UI-2)', async () => {
    render(<App />);
    await screen.findByRole('button', {name: 'Sign in with OpenEMR'});

    await chooseTheme('Dark');

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('when the app opens with no connection, then the offline shell says so and offers no sign-in or patient data (FR-PWA-4, W-8)', async () => {
    answerSession(() => HttpResponse.error());
    render(<App />);

    expect(
      await screen.findByRole('heading', {name: 'No connection'}),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {name: 'Sign in with OpenEMR'}),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('banner')).queryByRole('button', {
        name: /^Signed in/,
      }),
    ).not.toBeInTheDocument();

    answerSession(signedIn);
    await userEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(
      await screen.findByRole('button', {name: 'Signed in as Dr. Avery Demo'}),
    ).toBeInTheDocument();
  });

  it('when the session read fails, then sign-in is still offered, with a notice and "Try again"', async () => {
    answerSession(() => new HttpResponse(null, {status: 502}));
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't check your sign-in",
    );
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeInTheDocument();

    answerSession(signedIn);
    await userEvent.click(screen.getByRole('button', {name: 'Try again'}));

    expect(
      await screen.findByRole('button', {name: 'Signed in as Dr. Avery Demo'}),
    ).toBeInTheDocument();
  });
});

describe('given a signed-in clinician', () => {
  beforeEach(() => {
    answerSession(signedIn);
  });

  it('when the app loads, then the app bar shows who is signed in, with the theme selector beside it (FR-UI-3)', async () => {
    render(<App />);

    const banner = screen.getByRole('banner');
    expect(
      await within(banner).findByRole('button', {
        name: 'Signed in as Dr. Avery Demo',
      }),
    ).toBeInTheDocument();
    expect(
      within(banner).getByRole('button', {name: 'Theme'}),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {name: 'Sign in with OpenEMR'}),
    ).not.toBeInTheDocument();
  });

  it('when the clinician chooses Dark, then the app switches to dark (FR-UI-2)', async () => {
    render(<App />);
    await within(screen.getByRole('banner')).findByRole('button', {
      name: 'Signed in as Dr. Avery Demo',
    });

    await chooseTheme('Dark');

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it("when the account menu opens, then it shows the build's app version (FR-UI-3)", async () => {
    render(<App />);
    await userEvent.click(
      await within(screen.getByRole('banner')).findByRole('button', {
        name: 'Signed in as Dr. Avery Demo',
      }),
    );

    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: `Version ${APP_VERSION}`,
      }),
    ).toBeInTheDocument();
  });

  it('when the app has loaded, then /bff/session was read exactly once', async () => {
    render(<App />);
    await within(screen.getByRole('banner')).findByRole('button', {
      name: 'Signed in as Dr. Avery Demo',
    });

    expect(sessionReads).toBe(1);
  });
});

describe('given the token handler sent the browser to /signed-out', () => {
  it('when the reason is idle, then the inactivity notice shows with sign-in, and the session is not read', async () => {
    window.history.replaceState(null, '', '/signed-out?reason=idle');
    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Signed out for inactivity',
    );
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toHaveFocus();
    await Promise.resolve();
    expect(sessionReads).toBe(0);
  });

  it('when the reason is signout_partial, then the warning shows with sign-in, and the session is not read', async () => {
    window.history.replaceState(null, '', '/signed-out?reason=signout_partial');
    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'OpenEMR may still be signed in',
    );
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toHaveFocus();
    await Promise.resolve();
    expect(sessionReads).toBe(0);
  });

  it('when a malformed logout-reason cookie is present, then the generic notice still renders instead of a blank page', () => {
    document.cookie = 'bff-logout-reason=%E0; Path=/';
    window.history.replaceState(null, '', '/signed-out');
    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent("You're signed out");
    expect(
      screen.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeVisible();
    expect(document.cookie).not.toContain('bff-logout-reason=');
  });

  it('when the reason is not one the app knows, then the generic notice shows and the value is not on the page', () => {
    window.history.replaceState(
      null,
      '',
      '/signed-out?reason=%3Cb%3EZzreflected%3C%2Fb%3E',
    );
    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent("You're signed out");
    expect(document.body).not.toHaveTextContent('Zzreflected');
  });
});

// reference: REQUIREMENTS.md FR-PAT-1, FR-PAT-2, FR-UI-3, FR-UI-7, NFR-SEC-6 · REQUIREMENTS.md W-2, W-12c ·
// INTERFACES.md API-11
describe('given a signed-in clinician finding a patient', HEAVY_SUITE, () => {
  const FAKEY = patient({
    id: 'test-patient-0001',
    name: [{use: 'official', family: 'Testperson', given: ['Fakey']}],
  });
  const OTHER = patient({
    id: 'test-patient-0002',
    name: [{use: 'official', family: 'Testperson', given: ['Other']}],
    identifier: [],
  });
  const TWO_PATIENTS = searchBundle([FAKEY, OTHER]);

  // The chart reads each patient by id (API-12); every card read answers an empty Bundle.
  const READS: Readonly<Record<string, ReturnType<typeof patient>>> = {
    'test-patient-0001': FAKEY,
    'test-patient-0002': OTHER,
  };
  let patientReads: string[] = [];

  beforeEach(() => {
    patientReads = [];
    answerSession(signedIn);
    server.use(
      http.get('/bff/fhir/Patient', () => HttpResponse.json(TWO_PATIENTS)),
      http.get('/bff/fhir/Patient/:id', ({params}) => {
        const id = String(params.id);
        patientReads.push(id);
        return HttpResponse.json(READS[id]);
      }),
      http.get('/bff/fhir/:type', () => HttpResponse.json(searchBundle([]))),
    );
  });

  async function search(): Promise<HTMLElement> {
    await userEvent.type(
      await screen.findByRole('textbox', {name: 'Name'}),
      'Testperson',
    );
    await userEvent.click(screen.getByRole('button', {name: 'Search'}));
    return screen.findByRole('list', {name: 'Search results'});
  }

  const row = (list: HTMLElement, name: string) =>
    within(list).getByRole('button', {name: new RegExp(`^${name} `)});

  it('when signed in, then patient search (W-2) is the first screen, and the app bar offers no Patients button yet', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', {level: 1, name: 'Patient search'}),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('banner')).queryByRole('button', {
        name: 'Patients',
      }),
    ).toBeNull();
  });

  it('when a result is tapped, then /patient/:id opens with the patient named and focused, and no name, DOB or MRN is in the URL (FR-PAT-2)', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));

    expect(window.location.pathname).toBe('/patient/test-patient-0001');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(window.history.state).toBeNull();
    for (const phi of ['Testperson', 'Fakey', '1970', 'TEST-MRN']) {
      expect(window.location.href).not.toContain(phi);
    }
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {level: 1, name: 'Fakey Testperson'}),
      ).toHaveFocus();
    });
    expect(document.title).not.toContain('Testperson');
  });

  it('when a result is tapped, then the chart is the patient header above the dashboard and its cards, not a placeholder (FR-HDR-1)', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));

    const header = await screen.findByRole('region', {name: 'Patient'});
    expect(
      await within(header).findByRole('heading', {
        level: 1,
        name: 'Fakey Testperson',
      }),
    ).toBeInTheDocument();
    expect(within(header).getByText('TEST-MRN-0001')).toBeInTheDocument();
    const dashboard = screen.getByRole('region', {name: 'Dashboard'});
    expect(
      header.compareDocumentPosition(dashboard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(dashboard).getByRole('region', {name: 'Problem List'}),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('The patient dashboard lands here next.'),
    ).toBeNull();
    expect(patientReads).toEqual(['test-patient-0001']);
  });

  it('when a chart is opened by its address, then the header reads that patient and names them (a chart without search)', async () => {
    window.history.replaceState(null, '', '/patient/test-patient-0002');
    render(<App />);

    const header = await screen.findByRole('region', {name: 'Patient'});
    expect(
      await within(header).findByRole('heading', {
        level: 1,
        name: 'Other Testperson',
      }),
    ).toBeInTheDocument();
    expect(patientReads).toEqual(['test-patient-0002']);
  });

  it('when a chart read answers 401, then the chart unmounts and sign-in says the session ended (guards PHI left on screen after the session, FR-AUTH-3)', async () => {
    server.use(
      http.get('/bff/fhir/Patient/:id', () =>
        HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
      ),
    );
    window.history.replaceState(null, '', '/patient/test-patient-0001');
    render(<App />);

    expect(
      await screen.findByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeInTheDocument();
    expect(screen.getByText('Your session has ended')).toBeInTheDocument();
    expect(screen.queryByRole('region', {name: 'Patient'})).toBeNull();
    expect(screen.queryByRole('region', {name: 'Dashboard'})).toBeNull();
  });

  it('when Back is pressed on the chart, then the search returns with its results (FR-PAT-2)', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));

    window.history.back();

    const list = await screen.findByRole('list', {name: 'Search results'});
    expect(window.location.pathname).toBe('/');
    expect(row(list, 'Other Testperson')).toBeVisible();
    expect(screen.getByRole('textbox', {name: 'Name'})).toHaveValue(
      'Testperson',
    );
  });

  it('when a chart is open, then the app bar Patients button returns to the search (FR-UI-3)', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));
    await userEvent.click(
      within(screen.getByRole('banner')).getByRole('button', {
        name: 'Patients',
      }),
    );

    expect(window.location.pathname).toBe('/');
    expect(
      await screen.findByRole('list', {name: 'Search results'}),
    ).toBeVisible();
  });

  it('when another patient is tapped while a chart is open, then "Open another chart?" asks first with Cancel focused, and Escape keeps the current chart and returns focus to the row (W-12c, FR-UI-7)', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));
    window.history.back();
    const list = await screen.findByRole('list', {name: 'Search results'});
    const other = row(list, 'Other Testperson');
    await userEvent.click(other);

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Open another chart?',
    });
    expect(dialog).toHaveTextContent(
      "You're viewing Fakey Testperson. Opening Other Testperson closes this chart.",
    );
    expect(within(dialog).getByRole('button', {name: 'Cancel'})).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(window.location.pathname).toBe('/');
    await waitFor(() => {
      expect(row(list, 'Other Testperson')).toHaveFocus();
    });
  });

  it('when the switch is confirmed, then the other chart opens with its name focused', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));
    window.history.back();
    const list = await screen.findByRole('list', {name: 'Search results'});
    await userEvent.click(row(list, 'Other Testperson'));
    await userEvent.click(
      await screen.findByRole('button', {name: 'Open chart'}),
    );

    expect(window.location.pathname).toBe('/patient/test-patient-0002');
    const header = await screen.findByRole('region', {name: 'Patient'});
    const heading = await within(header).findByRole('heading', {
      level: 1,
      name: 'Other Testperson',
    });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(screen.queryByText('Fakey Testperson')).toBeNull();
  });

  it('when the switch is confirmed and the other patient is slow to read, then focus still lands on its name once the dialog has gone (W-12c)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    server.use(
      http.get('/bff/fhir/Patient/test-patient-0002', async () => {
        await held;
        return HttpResponse.json(OTHER);
      }),
    );
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));
    window.history.back();
    const list = await screen.findByRole('list', {name: 'Search results'});
    await userEvent.click(row(list, 'Other Testperson'));
    await userEvent.click(
      await screen.findByRole('button', {name: 'Open chart'}),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    release();
    const header = await screen.findByRole('region', {name: 'Patient'});
    const heading = await within(header).findByRole('heading', {
      level: 1,
      name: 'Other Testperson',
    });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('when the patient already open is tapped again, then it reopens without asking', async () => {
    render(<App />);
    await userEvent.click(row(await search(), 'Fakey Testperson'));
    window.history.back();
    const list = await screen.findByRole('list', {name: 'Search results'});
    await userEvent.click(row(list, 'Fakey Testperson'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.pathname).toBe('/patient/test-patient-0001');
  });
});
