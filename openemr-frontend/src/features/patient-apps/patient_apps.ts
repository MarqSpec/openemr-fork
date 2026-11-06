import {PATIENT_ID_PLACEHOLDER} from '../../api/config/runtime_config';

// Per-patient app launches (the AgentForge module first) are configuration, not code: the token handler serves them
// at run time (API-48) and the SPA only builds a link. The target re-checks access and mints its own launch, so no
// OpenEMR change is needed (NFR-CON-1).
// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1

export type {PatientApp} from '../../api/config/runtime_config';

/** The launch URL for one patient: the placeholder becomes the percent-encoded id, and nothing else is added. */
export function launchUrl(template: string, patientId: string): string {
  return template.replaceAll(
    PATIENT_ID_PLACEHOLDER,
    encodeURIComponent(patientId),
  );
}
