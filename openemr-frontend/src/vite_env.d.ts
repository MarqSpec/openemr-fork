/// <reference types="vite/client" />

// The build-time public configuration the SPA reads (never a secret). reference: src/auth/session_config.ts,
// src/features/patient-apps/patient_apps.ts
interface ImportMetaEnv {
  /** Seconds the app may stay hidden before it signs out (W-7); default 60. */
  readonly VITE_PRIVACY_GRACE_SECONDS?: string;
  /** JSON list of per-patient app launches (FR-APP-1); unset = no patient-apps slot. */
  readonly VITE_PATIENT_APPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
