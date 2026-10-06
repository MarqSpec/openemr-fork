// Parses what a clinician typed into a Patient search (API-11) before anything is sent: each value must fit the
// shape the token handler's allow-list accepts, so a refusal is explained here rather than arriving as a
// 404. Only a parsed PatientSearch reaches the network. reference: INTERFACES.md API-11 ·
// REQUIREMENTS.md FR-PAT-1

/** Rows per page. API-11 is the only search whose `_count`/`_offset` OpenEMR honours (BUG-7). */
export const PATIENT_PAGE_SIZE = 20;

/** Name: letters (any script), combining marks, apostrophe, space, full stop, hyphen; 2–64 after trimming. */
const NAME = /^[\p{L}\p{M}' .-]{1,64}$/u;
const NAME_MIN = 2;
const BIRTH_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** MRN (`pubpid`): no `|`, so the value can never name a token system. */
const MRN = /^[A-Za-z0-9._:-]{1,64}$/;

/** The form's raw text, as typed. */
export interface PatientSearchInput {
  readonly name: string;
  readonly birthDate: string;
  readonly mrn: string;
}

export type PatientSearchField = keyof PatientSearchInput;

export type PatientSearchProblem =
  'name-too-short' | 'name-characters' | 'birth-date-format' | 'mrn-characters';

declare const PARSED: unique symbol;

/** A search every value of which fits API-11's allow-listed shape; build one only with {@link parsePatientSearch}. */
export interface PatientSearch {
  readonly [PARSED]: true;
  readonly name: string | undefined;
  readonly birthDate: string | undefined;
  readonly mrn: string | undefined;
}

export type ParsedPatientSearch =
  | {readonly ok: true; readonly search: PatientSearch}
  | {
      readonly ok: false;
      /** Nothing was typed in any field. */
      readonly empty: boolean;
      readonly problems: Partial<
        Record<PatientSearchField, PatientSearchProblem>
      >;
    };

/** Trims each field, drops blank ones, and checks the rest; at least one field is needed. */
export function parsePatientSearch(
  input: PatientSearchInput,
): ParsedPatientSearch {
  const name = input.name.trim();
  const birthDate = input.birthDate.trim();
  const mrn = input.mrn.trim();
  const problems: Partial<Record<PatientSearchField, PatientSearchProblem>> =
    {};

  if (name !== '') {
    if (!NAME.test(name)) problems.name = 'name-characters';
    else if ((name.match(/\p{L}/gu) ?? []).length < NAME_MIN) {
      problems.name = 'name-too-short';
    }
  }
  if (birthDate !== '' && !BIRTH_DATE.test(birthDate)) {
    problems.birthDate = 'birth-date-format';
  }
  if (mrn !== '' && !MRN.test(mrn)) problems.mrn = 'mrn-characters';

  const empty = name === '' && birthDate === '' && mrn === '';
  if (empty || Object.keys(problems).length > 0) {
    return {ok: false, empty, problems};
  }
  return {
    ok: true,
    search: {
      name: name === '' ? undefined : name,
      birthDate: birthDate === '' ? undefined : birthDate,
      mrn: mrn === '' ? undefined : mrn,
    } as PatientSearch,
  };
}
