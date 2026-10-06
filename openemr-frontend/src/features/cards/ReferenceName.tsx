import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import type {ReactNode} from 'react';

import {useOrganization, usePractitioner} from '../../api/fhir/hooks';
import {FHIR_ID, type Practitioner} from '../../api/fhir/schemas';
import {displayName} from '../patient-header/patient_format';

// reference: REQUIREMENTS.md NFR-PERF-3 · INTERFACES.md API-18, API-19 ·
// REQUIREMENTS.md BUG-10 · REQUIREMENTS.md W-5

/** A FHIR Reference as the cards receive it (CareTeam member, Encounter provider, MedicationRequest requester…). */
export interface NameReference {
  readonly reference?: string | undefined;
  readonly type?: string | undefined;
  readonly display?: string | undefined;
}

/** The resource types a card may read a name for: API-18 and API-19. */
export type NamedResourceType = 'Practitioner' | 'Organization';

const VISUALLY_HIDDEN = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

/**
 * The resource type and id in a relative reference (`Practitioner/{id}`), the type falling back to `type`; an id that
 * is not a plain FHIR id is dropped, so it is never read.
 */
export function referenceParts(
  reference: NameReference,
): {resourceType: string; id: string | undefined} | undefined {
  const match = /^([A-Za-z]+)\/([^/]+)$/.exec(reference.reference ?? '');
  const resourceType = match?.[1] ?? reference.type;
  if (resourceType === undefined) return undefined;
  const id = match?.[2];
  const valid =
    id !== undefined && FHIR_ID.test(id) && id !== '.' && id !== '..';
  return {resourceType, id: valid ? id : undefined};
}

/** W-5: any name OpenEMR will not or cannot give — refused (BUG-10), failed, malformed, blank or unreadable. */
export function NameUnavailable(): ReactNode {
  return (
    <Box component="span" sx={{color: 'text.secondary'}}>
      Name unavailable
    </Box>
  );
}

function NameLoading(props: {what: string}): ReactNode {
  return (
    <Box component="span" aria-busy="true">
      <Box component="span" sx={VISUALLY_HIDDEN}>
        Loading {props.what} name…
      </Box>
      <Skeleton variant="text" width="6em" />
    </Box>
  );
}

function LookedUpName(props: {
  what: string;
  isLoading: boolean;
  name: string | undefined;
}): ReactNode {
  if (props.isLoading) return <NameLoading what={props.what} />;
  const name = props.name?.trim() ?? '';
  return name === '' ? <NameUnavailable /> : name;
}

function PractitionerName(props: {
  id: string;
  what: string;
  format: (practitioner: Practitioner) => string | undefined;
}): ReactNode {
  const query = usePractitioner(props.id);
  const item = query.data;
  return (
    <LookedUpName
      what={props.what}
      isLoading={query.isPending && query.fetchStatus !== 'idle'}
      name={item?.kind === 'ok' ? props.format(item.resource) : undefined}
    />
  );
}

function OrganizationName(props: {id: string; what: string}): ReactNode {
  const query = useOrganization(props.id);
  const item = query.data;
  return (
    <LookedUpName
      what={props.what}
      isLoading={query.isPending && query.fetchStatus !== 'idle'}
      name={item?.kind === 'ok' ? item.resource.name : undefined}
    />
  );
}

const defaultPractitionerName = (practitioner: Practitioner) =>
  displayName(practitioner.name);

export interface ReferenceNameProps {
  readonly reference: NameReference;
  /** Which reads this card's inventory rows allow; any other type reads "Name unavailable" unread. */
  readonly readable: readonly NamedResourceType[];
  /** The name's role, for the loading text ("Loading {what} name…"). */
  readonly what: string;
  /** How the card writes a practitioner's name; the patient header's form by default. */
  readonly practitionerName?: (
    practitioner: Practitioner,
  ) => string | undefined;
}

/**
 * A referenced name, the one resolver every card shares: the reference's own display, else a read by id — API-18 or
 * API-19, each id read once per session and shared by every card (NFR-PERF-3), a refusal or failure included — else
 * "Name unavailable" (W-5). It never holds up the row it sits in. An absent reference is the card's to word.
 */
export function ReferenceName(props: ReferenceNameProps): ReactNode {
  const {reference, readable, what} = props;
  const display = reference.display?.trim() ?? '';
  if (display !== '') return display;
  const parts = referenceParts(reference);
  if (parts?.id === undefined) return <NameUnavailable />;
  if (
    parts.resourceType === 'Practitioner' &&
    readable.includes('Practitioner')
  ) {
    return (
      <PractitionerName
        id={parts.id}
        what={what}
        format={props.practitionerName ?? defaultPractitionerName}
      />
    );
  }
  if (
    parts.resourceType === 'Organization' &&
    readable.includes('Organization')
  ) {
    return <OrganizationName id={parts.id} what={what} />;
  }
  return <NameUnavailable />;
}
