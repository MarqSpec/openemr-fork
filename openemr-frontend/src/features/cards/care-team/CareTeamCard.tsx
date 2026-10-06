import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type {ReactNode} from 'react';

import {ApiError, type ApiFailure} from '../../../api/api_error';
import {useCareTeams} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {CareTeam} from '../../../api/fhir/schemas';
import {wallClockDate} from '../../../api/openemr_date';
import {DashboardCard} from '../DashboardCard';
import {fhirItemNoticeText} from '../fhir_item_notice';
import {ReferenceName, referenceParts} from '../ReferenceName';

// reference: REQUIREMENTS.md FR-CARD-CT-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-PERF-3 ·
// INTERFACES.md API-17, API-18, API-19 · REQUIREMENTS.md SCR-DASH-CT · REQUIREMENTS.md BUG-10, BUG-30,
// BUG-51, BUG-52 · REQUIREMENTS.md W-3, W-5

type Participant = NonNullable<CareTeam['participant']>[number];
type Reference = NonNullable<Participant['member']>;

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

/** The legacy table's columns, in its order (manage_care_team.html.twig). */
const COLUMNS = [
  'Type',
  'Member',
  'Role',
  'Facility',
  'Since',
  'Status',
  'Note',
] as const;

/** Legacy's `Care_Team_Status` titles for the FHIR team status codes. */
const STATUS_WORDS: ReadonlyMap<string, string> = new Map([
  ['proposed', 'Proposed'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
  ['inactive', 'Inactive'],
]);

/** Legacy's Type badge; any other member type is named as sent. */
const MEMBER_TYPES: ReadonlyMap<string, string> = new Map([
  ['Practitioner', 'Provider'],
  ['RelatedPerson', 'Related Person'],
]);

/**
 * Legacy lists members only. OpenEMR also sends one Organization participant per distinct member facility
 * (FhirCareTeamService::populateFacilityTeamMembers); that facility is already in its member's row.
 */
function isMemberRow(participant: Participant): boolean {
  if (participant.member === undefined) return true;
  return referenceParts(participant.member)?.resourceType !== 'Organization';
}

/** Legacy shows every team but one entered in error, the active team first (CareTeamService::getCareTeamData). */
function shownTeams(
  items: readonly FhirItem<CareTeam>[],
): FhirItem<CareTeam>[] {
  const kept = items.filter(item => {
    switch (item.kind) {
      case 'ok':
        return item.resource.status !== 'entered-in-error';
      case 'could-not-display':
      case 'more-not-shown':
        return true;
      default: {
        const unexpected: never = item;
        return unexpected;
      }
    }
  });
  const isActive = (item: FhirItem<CareTeam>) => {
    switch (item.kind) {
      case 'ok':
        return item.resource.status === 'active';
      case 'could-not-display':
      case 'more-not-shown':
        return false;
      default: {
        const unexpected: never = item;
        return unexpected;
      }
    }
  };
  return [...kept.filter(isActive), ...kept.filter(item => !isActive(item))];
}

function conceptText(concepts: Participant['role']): string | undefined {
  for (const concept of concepts ?? []) {
    const text = concept.text?.trim() ?? '';
    if (text !== '') return text;
    const display =
      concept.coding
        ?.map(coding => coding.display?.trim() ?? '')
        .find(value => value !== '') ?? '';
    if (display !== '') return display;
  }
  return undefined;
}

/** The date as OpenEMR stored it (`provider_since`, a DATE), never shifted to the tablet's zone (BUG-51). */
function sinceDate(participant: Participant): string | undefined {
  return wallClockDate(participant.period?.start);
}

function NotRecorded(props: {what: string}): ReactNode {
  return (
    <>
      <span aria-hidden="true">—</span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        {props.what} not recorded
      </Box>
    </>
  );
}

/** A member status or note: legacy has one per member, OpenEMR's FHIR sends neither (BUG-52). */
function NotSent(): ReactNode {
  return (
    <>
      <span aria-hidden="true">—</span>
      <Box component="span" sx={VISUALLY_HIDDEN}>
        Not sent by OpenEMR
      </Box>
    </>
  );
}

/**
 * A member or facility, through the cards' shared resolver: API-18 or API-19, each id read once per session
 * (NFR-PERF-3). Any other member type has no read in the inventory.
 */
function MemberOrFacility(props: {
  reference: Reference | undefined;
  what: 'Member' | 'Facility';
}): ReactNode {
  const {reference, what} = props;
  if (reference === undefined) return <NotRecorded what={what} />;
  return (
    <ReferenceName
      reference={reference}
      readable={['Practitioner', 'Organization']}
      what={what === 'Member' ? 'member' : 'facility'}
    />
  );
}

function Text(props: {value: string | undefined; what: string}): ReactNode {
  return props.value ?? <NotRecorded what={props.what} />;
}

function memberType(participant: Participant): string | undefined {
  if (participant.member === undefined) return undefined;
  const resourceType = referenceParts(participant.member)?.resourceType;
  return resourceType === undefined
    ? undefined
    : (MEMBER_TYPES.get(resourceType) ?? resourceType);
}

function MemberRow(props: {participant: Participant}): ReactNode {
  const {participant} = props;
  return (
    <TableRow>
      <TableCell>
        <Text value={memberType(participant)} what="Type" />
      </TableCell>
      <TableCell>
        <MemberOrFacility reference={participant.member} what="Member" />
      </TableCell>
      <TableCell>
        <Text value={conceptText(participant.role)} what="Role" />
      </TableCell>
      <TableCell>
        <MemberOrFacility reference={participant.onBehalfOf} what="Facility" />
      </TableCell>
      <TableCell sx={{whiteSpace: 'nowrap'}}>
        <Text value={sinceDate(participant)} what="Since" />
      </TableCell>
      <TableCell>
        <NotSent />
      </TableCell>
      <TableCell>
        <NotSent />
      </TableCell>
    </TableRow>
  );
}

function teamHeading(team: CareTeam): string {
  const name = team.name?.trim() ?? '';
  const status =
    team.status === undefined ? undefined : STATUS_WORDS.get(team.status);
  const title = name === '' ? 'Care team' : name;
  return status === undefined ? title : `${title} — ${status}`;
}

function TeamTable(props: {team: CareTeam}): ReactNode {
  const members = (props.team.participant ?? []).filter(isMemberRow);
  return (
    <Box>
      <Typography
        component="h3"
        sx={{fontSize: '0.875rem', fontWeight: 700, mt: 1, mb: 0.5}}
      >
        {teamHeading(props.team)}
      </Typography>
      {members.length === 0 ? (
        <Typography color="textSecondary">No members listed</Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                {COLUMNS.map(column => (
                  <TableCell key={column} sx={{fontWeight: 700}}>
                    {column}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((participant, index) => (
                // Participants have no id; their order in the team is stable.
                <MemberRow key={index} participant={participant} />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

function ItemNotice(props: {
  kind: 'could-not-display' | 'more-not-shown';
}): ReactNode {
  return (
    <Typography color="textSecondary" sx={{mt: 1}}>
      <span aria-hidden="true">⚠ </span>
      {fhirItemNoticeText(props.kind, 'care teams')}
    </Typography>
  );
}

function CareTeams(props: {items: readonly FhirItem<CareTeam>[]}): ReactNode {
  const items = shownTeams(props.items);
  if (items.length === 0) {
    return <Typography color="textSecondary">Nothing Recorded</Typography>;
  }
  const anyMember = items.some(
    item =>
      item.kind === 'ok' && (item.resource.participant ?? []).some(isMemberRow),
  );
  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case 'ok':
            return <TeamTable key={item.resource.id} team={item.resource} />;
          case 'could-not-display':
          case 'more-not-shown':
            // An item that did not parse has no id to key on; its place in the list is stable.
            return (
              <ItemNotice
                key={`${item.kind}-${String(index)}`}
                kind={item.kind}
              />
            );
          default: {
            const unexpected: never = item;
            return unexpected;
          }
        }
      })}
      {anyMember ? (
        <Typography color="textSecondary" sx={{mt: 1}}>
          OpenEMR&apos;s FHIR API does not send each member&apos;s status or
          note, and it also lists members removed from the team. Check them in
          OpenEMR.
        </Typography>
      ) : null}
    </>
  );
}

/** Words for a failure a retry may fix (as CardItems words them). */
function failureDetail(failure: ApiFailure | undefined): string {
  switch (failure?.kind) {
    case 'server-error':
      return ' (server error)';
    case 'network-error':
      return ' (no connection)';
    default:
      return '';
  }
}

export interface CareTeamCardProps {
  readonly patientId: string;
}

/**
 * The Care Team card (SCR-DASH-CT): the legacy table — type, member, role, facility, since, status, note — under
 * each team's name and status. Names are looked up per row and never hold up the table; one OpenEMR will not give
 * reads "Name unavailable" (BUG-10, PRD Q-9). Its states are CardItems' own, in tables rather than a list.
 */
export function CareTeamCard(props: CareTeamCardProps): ReactNode {
  const query = useCareTeams(props.patientId);

  let body: ReactNode = null;
  if (query.isPending) {
    if (query.fetchStatus !== 'idle') {
      body = (
        <Box aria-busy="true">
          <Box component="span" sx={VISUALLY_HIDDEN}>
            Loading the care team…
          </Box>
          <Skeleton variant="text" width="80%" />
          <Skeleton variant="text" width="60%" />
        </Box>
      );
    }
  } else if (query.isError) {
    const failure =
      query.error instanceof ApiError ? query.error.failure : undefined;
    if (failure?.kind === 'not-authorised') {
      body = (
        <Alert severity="warning">
          You&apos;re not authorised to view the care team. Access is controlled
          in OpenEMR.
        </Alert>
      );
    } else if (failure?.kind !== 'session-over') {
      body = (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              disabled={query.isFetching}
              sx={{minHeight: 48, minWidth: 48}}
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          }
        >
          Couldn&apos;t load the care team{failureDetail(failure)}.
        </Alert>
      );
    }
  } else {
    body = <CareTeams items={query.data} />;
  }

  return <DashboardCard title="Care Team">{body}</DashboardCard>;
}
