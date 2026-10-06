import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {useEffect, useId, useRef, useState, type SyntheticEvent} from 'react';

import {ApiError} from '../../api/api_error';
import {usePatientSearch} from '../../api/fhir/hooks';
import {
  parsePatientSearch,
  type PatientSearch as ParsedSearch,
  type PatientSearchField,
  type PatientSearchInput,
  type PatientSearchProblem,
} from '../../api/fhir/patient_search';
import type {Patient} from '../../api/fhir/schemas';
import {displayName, mrnOf, sexLabel} from '../patient-header/patient_format';
import {TOUCH_TARGET} from '../../theme/tokens';

// W-2: find a patient by name, date of birth or MRN, and open the chart by id. What was typed stays in memory —
// never the URL, history, storage or a log. reference: REQUIREMENTS.md FR-PAT-1, FR-PAT-2,
// NFR-SEC-1, NFR-SEC-6, NFR-A11Y-2 · INTERFACES.md API-11 · REQUIREMENTS.md W-2

/** What the search screen remembers while a chart is open, so Back returns to the same results (FR-PAT-2). */
export interface PatientSearchState {
  readonly input: PatientSearchInput;
  /** The last search run; `undefined` until Search is first pressed with valid terms. */
  readonly search: ParsedSearch | undefined;
  /** Page shown, from 0. */
  readonly page: number;
}

export const EMPTY_PATIENT_SEARCH: PatientSearchState = {
  input: {name: '', birthDate: '', mrn: ''},
  search: undefined,
  page: 0,
};

/** The patient a clinician chose: the logical id opens the chart; the name is only for display. */
export interface OpenedPatient {
  readonly id: string;
  readonly name: string | undefined;
}

interface PatientSearchProps {
  readonly state: PatientSearchState;
  readonly onStateChange: (next: PatientSearchState) => void;
  /** A result was tapped. */
  readonly onOpen: (patient: OpenedPatient) => void;
}

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

const COLUMNS = '2fr 1fr 0.6fr 1fr';
const FIELDS: readonly PatientSearchField[] = ['name', 'birthDate', 'mrn'];

const PROBLEM_TEXT: Readonly<Record<PatientSearchProblem, string>> = {
  'name-too-short': 'Enter at least 2 letters.',
  'name-characters': 'Use letters, spaces, apostrophes, hyphens or full stops.',
  'birth-date-format': 'Enter the date as YYYY-MM-DD.',
  'mrn-characters':
    'Use letters, digits, full stops, hyphens, colons or underscores.',
};

const HINTS: Readonly<Record<PatientSearchField, string>> = {
  name: 'One name: the start of a surname or given name',
  birthDate: 'YYYY-MM-DD',
  mrn: 'The whole MRN',
};

type Problems = Partial<Record<PatientSearchField, PatientSearchProblem>>;

export function PatientSearch({
  state,
  onStateChange,
  onOpen,
}: PatientSearchProps) {
  const [problems, setProblems] = useState<Problems>({});
  const [empty, setEmpty] = useState(false);
  const headingId = useId();
  const fields = {
    name: useRef<HTMLInputElement>(null),
    birthDate: useRef<HTMLInputElement>(null),
    mrn: useRef<HTMLInputElement>(null),
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parsePatientSearch(state.input);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      setEmpty(parsed.empty);
      const first = FIELDS.find(field => parsed.problems[field] !== undefined);
      fields[first ?? 'name'].current?.focus();
      return;
    }
    setProblems({});
    setEmpty(false);
    onStateChange({...state, search: parsed.search, page: 0});
  };

  const field = (name: PatientSearchField, label: string) => {
    const problem = problems[name];
    return (
      <TextField
        label={label}
        value={state.input[name]}
        onChange={event => {
          onStateChange({
            ...state,
            input: {...state.input, [name]: event.target.value},
          });
        }}
        inputRef={fields[name]}
        autoComplete="off"
        error={problem !== undefined}
        helperText={problem === undefined ? HINTS[name] : PROBLEM_TEXT[problem]}
        sx={{flex: '1 1 180px'}}
      />
    );
  };

  return (
    <Box component="section" aria-labelledby={headingId} sx={{p: 2}}>
      <Typography
        id={headingId}
        component="h1"
        variant="h5"
        sx={{fontWeight: 700, mb: 2}}
      >
        Patient search
      </Typography>
      <Box
        component="form"
        role="search"
        aria-label="Patients"
        noValidate
        onSubmit={submit}
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1.5,
          alignItems: 'flex-start',
          p: 1.5,
          bgcolor: 'background.paper',
          boxShadow: 1,
        }}
      >
        {field('name', 'Name')}
        {field('birthDate', 'Date of birth')}
        {field('mrn', 'MRN')}
        <Button
          type="submit"
          variant="contained"
          disableElevation
          sx={{minHeight: 56, minWidth: TOUCH_TARGET, px: 3}}
        >
          Search
        </Button>
      </Box>
      {empty && (
        <Typography role="alert" color="error" sx={{mt: 1}}>
          Enter a name, date of birth or MRN.
        </Typography>
      )}
      {state.search !== undefined && (
        <Results
          search={state.search}
          page={state.page}
          onPage={page => {
            onStateChange({...state, page});
          }}
          onOpen={onOpen}
        />
      )}
    </Box>
  );
}

interface ResultsProps {
  readonly search: ParsedSearch;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onOpen: (patient: OpenedPatient) => void;
}

function Results({search, page, onPage, onOpen}: ResultsProps) {
  const query = usePatientSearch(search, page);
  const summary = useRef<HTMLParagraphElement>(null);
  const turned = useRef(false);

  // After Next or Previous, the old controls are gone; land focus on the new page's summary.
  useEffect(() => {
    if (query.isSuccess && turned.current) {
      turned.current = false;
      summary.current?.focus();
    }
  }, [query.isSuccess, page]);

  const turn = (next: number) => {
    turned.current = true;
    onPage(next);
  };

  if (query.isPending) {
    return (
      <Typography role="status" color="textSecondary" sx={{mt: 2}}>
        Searching…
      </Typography>
    );
  }
  if (query.isError) {
    const kind =
      query.error instanceof ApiError ? query.error.failure.kind : undefined;
    // The session provider shows sign-in on a 401; nothing to draw here.
    if (kind === 'session-over') return null;
    if (kind === 'not-authorised') {
      return (
        <Alert severity="error" sx={{mt: 2}}>
          <AlertTitle>Not authorised to search patients</AlertTitle>
          Your OpenEMR account or this sign-in does not allow patient search.
        </Alert>
      );
    }
    return (
      <Alert
        severity="error"
        sx={{mt: 2}}
        action={
          <Button
            color="inherit"
            onClick={() => {
              void query.refetch();
            }}
            sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
          >
            Try again
          </Button>
        }
      >
        <AlertTitle>Couldn&apos;t search patients</AlertTitle>
        {kind === 'network-error'
          ? 'The server could not be reached.'
          : 'The server did not answer the search.'}
      </Alert>
    );
  }

  const {items, hasMore} = query.data;
  if (items.length === 0) {
    return (
      <Box role="status" sx={{mt: 2}}>
        <Typography>No patients match</Typography>
        {/* OpenEMR prefix-matches the whole value against each name field, so "Given Family" finds nobody (Q-3). */}
        {search.name?.includes(' ') === true && (
          <Typography color="textSecondary">
            OpenEMR matches the name against one name at a time. Search one
            name, e.g. the surname.
          </Typography>
        )}
      </Box>
    );
  }

  const count = `${String(items.length)} ${items.length === 1 ? 'patient' : 'patients'}`;
  return (
    <Box sx={{mt: 2}}>
      <Box
        aria-hidden="true"
        sx={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          gap: 1,
          px: 1.5,
          minHeight: 36,
          alignItems: 'center',
          color: 'text.secondary',
          typography: 'body2',
        }}
      >
        <span>Name</span>
        <span>Date of birth</span>
        <span>Sex</span>
        <span>MRN</span>
      </Box>
      <Box
        component="ul"
        aria-label="Search results"
        sx={{listStyle: 'none', m: 0, p: 0}}
      >
        {items.map((item, index) => (
          <Box
            component="li"
            key={item.kind === 'ok' ? item.resource.id : `bad-${String(index)}`}
            sx={{
              borderTop: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
            }}
          >
            {item.kind === 'ok' ? (
              <ResultRow patient={item.resource} onOpen={onOpen} />
            ) : (
              <Typography
                color="textSecondary"
                sx={{
                  minHeight: 52,
                  px: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                Could not display this patient
              </Typography>
            )}
          </Box>
        ))}
      </Box>
      <Box
        component="nav"
        aria-label="Result pages"
        // On the surface, not the page grey: the primary text buttons are under 4.5:1 on the grey.
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mt: 1,
          flexWrap: 'wrap',
          bgcolor: 'background.paper',
        }}
      >
        <Typography
          ref={summary}
          tabIndex={-1}
          role="status"
          color="textSecondary"
          sx={{flex: 1, px: 1.5}}
        >
          Page {page + 1} · {count}
        </Typography>
        <Button
          disabled={page === 0}
          onClick={() => {
            turn(page - 1);
          }}
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
        >
          Previous page
        </Button>
        <Button
          disabled={!hasMore}
          onClick={() => {
            turn(page + 1);
          }}
          sx={{minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET}}
        >
          Next page
        </Button>
      </Box>
    </Box>
  );
}

function Cell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | undefined;
}) {
  return (
    <span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        {label}
      </Box>{' '}
      <Recorded value={value} />
    </span>
  );
}

/** A missing value shows "—" and is read as "not recorded" (FR-HDR-3's convention). */
function Recorded({value}: {readonly value: string | undefined}) {
  if (value !== undefined) return <>{value}</>;
  return (
    <>
      <span aria-hidden="true">—</span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        not recorded
      </Box>
    </>
  );
}

function ResultRow({
  patient,
  onOpen,
}: {
  readonly patient: Patient;
  readonly onOpen: (patient: OpenedPatient) => void;
}) {
  const name = displayName(patient.name);
  return (
    <ButtonBase
      onClick={() => {
        onOpen({id: patient.id, name});
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        gap: 1,
        width: '100%',
        minHeight: 52,
        px: 1.5,
        textAlign: 'left',
        alignItems: 'center',
        justifyItems: 'start',
        typography: 'body1',
        '&:hover': {bgcolor: 'action.hover'},
        '&.Mui-focusVisible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '-2px',
        },
      }}
    >
      <Box component="span" sx={{fontWeight: 700}}>
        {name ?? (
          <>
            Name <Recorded value={undefined} />
          </>
        )}
      </Box>{' '}
      <Cell label="Date of birth" value={patient.birthDate} />{' '}
      <Cell label="Sex" value={sexLabel(patient)} />{' '}
      <Cell label="MRN" value={mrnOf(patient.identifier)} />
    </ButtonBase>
  );
}
