/**
 * The scopes requested at sign-in: exactly `config/oauth-scopes.json` (INTERFACES.md §2), copied here
 * so the deployed service does not read outside its package. `oauth_scopes.test.ts` fails if the two drift.
 * reference: REQUIREMENTS.md FR-AUTH-2, NFR-SEC-4
 */
export const OAUTH_SCOPES: readonly string[] = [
  'openid',
  'fhirUser',
  'offline_access',
  'api:fhir',
  'user/Patient.read',
  'user/AllergyIntolerance.read',
  'user/Condition.read',
  'user/MedicationRequest.read',
  'user/CareTeam.read',
  'user/Encounter.read',
  'user/Practitioner.read',
  'user/Organization.read',
  'user/Observation.read',
  'user/Immunization.read',
  'user/Appointment.read',
];
