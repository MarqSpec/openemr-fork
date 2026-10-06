import {within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';

import {
  allergy,
  appointment,
  careTeam,
  encounter,
  immunization,
  labResult,
  organization,
  practitioner,
  prescription,
  searchBundle,
  vitalsForm,
} from './fhir_fixtures';
import {server} from './msw_server';

// Shared by the specs that mount the whole dashboard, which are the slowest in the suite.

/**
 * Answers every read the dashboard's wired cards make, one synthetic row each, so a spec that mounts it leaves no
 * request for MSW to reject and no card drawing an error it did not ask for. The Problem List gets `problems`; a
 * spec replaces any other read with its own `server.use`.
 */
export function answerDashboardReads(problems: readonly unknown[] = []): void {
  server.use(
    http.get('/bff/fhir/Condition', () =>
      HttpResponse.json(searchBundle(problems)),
    ),
    http.get('/bff/fhir/AllergyIntolerance', () =>
      HttpResponse.json(searchBundle([allergy()])),
    ),
    http.get('/bff/fhir/Appointment', () =>
      HttpResponse.json(searchBundle([appointment()])),
    ),
    http.get('/bff/fhir/MedicationRequest', () =>
      HttpResponse.json(searchBundle([prescription()])),
    ),
    // The Labs card's read only (API-22): any other Observation read falls through to the next handler.
    http.get('/bff/fhir/Observation', ({request}) =>
      new URL(request.url).searchParams.get('category') === 'laboratory'
        ? HttpResponse.json(searchBundle([labResult()]))
        : undefined,
    ),
    http.get('/bff/fhir/CareTeam', () =>
      HttpResponse.json(searchBundle([careTeam()])),
    ),
    http.get('/bff/fhir/Encounter', () =>
      HttpResponse.json(searchBundle([encounter()])),
    ),
    http.get('/bff/fhir/Observation', () =>
      HttpResponse.json(
        searchBundle(vitalsForm('2026-09-10T09:00:00-04:00', 'test-vitals')),
      ),
    ),
    http.get('/bff/fhir/Practitioner/:id', () =>
      HttpResponse.json(practitioner()),
    ),
    http.get('/bff/fhir/Organization/:id', () =>
      HttpResponse.json(organization()),
    ),
    http.get('/bff/fhir/Immunization', () =>
      HttpResponse.json(searchBundle([immunization()])),
    ),
  );
}

/**
 * Looks up the regions under `container` by accessible name, from one role query. Each role query walks the whole
 * tree and reads every candidate's computed style, which jsdom does slowly, so a spec that asked for each card on
 * its own paid that once per card. Throws, as `getByRole` would, for a name with no region or with more than one.
 */
export function regionsByName(
  container: HTMLElement,
): (name: string) => HTMLElement {
  const found = new Map<string, HTMLElement[]>();
  within(container).getAllByRole('region', {
    name: (accessibleName, element) => {
      if (element instanceof HTMLElement) {
        found.set(accessibleName, [
          ...(found.get(accessibleName) ?? []),
          element,
        ]);
      }
      return true;
    },
  });
  return name => {
    const matches = found.get(name) ?? [];
    const [only] = matches;
    if (only === undefined || matches.length > 1) {
      throw new Error(
        `expected one region named "${name}", found ${String(matches.length)}`,
      );
    }
    return only;
  };
}
