import Box from '@mui/material/Box';
import type {ReactNode} from 'react';

import {EXPANDED} from '../../theme/window_class';
import {AllergiesCard} from '../cards/allergies/AllergiesCard';
import {AppointmentsCard} from '../cards/appointments/AppointmentsCard';
import {CardBoundary} from '../cards/DashboardCard';
import {CareTeamCard} from '../cards/care-team/CareTeamCard';
import {EncounterHistoryCard} from '../cards/encounter-history/EncounterHistoryCard';
import {ImmunizationsCard} from '../cards/immunizations/ImmunizationsCard';
import {LabsCard} from '../cards/labs/LabsCard';
import {MedicationsCard} from '../cards/medications/MedicationsCard';
import {PrescriptionsCard} from '../cards/prescriptions/PrescriptionsCard';
import {ProblemListCard} from '../cards/problem-list/ProblemListCard';
import {VitalsCard} from '../cards/vitals/VitalsCard';

// reference: REQUIREMENTS.md FR-UI-1, FR-CARD-1, NFR-UX-1 · REQUIREMENTS.md SCR-DASH §5.3 ·
// REQUIREMENTS.md W-3, W-4

export interface DashboardProps {
  readonly patientId: string;
}

const STACK = {display: 'grid', gap: 1, alignContent: 'start'} as const;

/** A row that splits into `columns` on the expanded window class and stacks on medium. */
function Row(props: {columns: string; children: ReactNode}): ReactNode {
  return (
    <Box
      sx={{
        ...STACK,
        [EXPANDED]: {gridTemplateColumns: props.columns, alignItems: 'start'},
      }}
    >
      {props.children}
    </Box>
  );
}

/**
 * The dashboard in the legacy arrangement (SCR-DASH): Allergies · Problems · Medications in a row, Prescriptions
 * and Care Team full width, then a wide left column and a narrow right one (legacy col-md-8 / col-md-4). On the
 * medium window class the same DOM stacks into one column, so the reading order is the legacy order in both.
 */
export function Dashboard(props: DashboardProps): ReactNode {
  return (
    <Box component="section" aria-label="Dashboard" sx={{...STACK, p: 1}}>
      <Row columns="repeat(3, minmax(0, 1fr))">
        <CardBoundary patientId={props.patientId} title="Allergies">
          <AllergiesCard patientId={props.patientId} />
        </CardBoundary>
        <CardBoundary patientId={props.patientId} title="Problem List">
          <ProblemListCard patientId={props.patientId} />
        </CardBoundary>
        <CardBoundary patientId={props.patientId} title="Medications">
          <MedicationsCard patientId={props.patientId} />
        </CardBoundary>
      </Row>
      <CardBoundary patientId={props.patientId} title="Prescriptions">
        <PrescriptionsCard patientId={props.patientId} />
      </CardBoundary>
      <CardBoundary patientId={props.patientId} title="Care Team">
        <CareTeamCard patientId={props.patientId} />
      </CardBoundary>
      <Row columns="minmax(0, 2fr) minmax(0, 1fr)">
        <Box sx={STACK}>
          <CardBoundary patientId={props.patientId} title="Encounter History">
            <EncounterHistoryCard patientId={props.patientId} />
          </CardBoundary>
        </Box>
        <Box sx={STACK}>
          <CardBoundary patientId={props.patientId} title="Vitals">
            <VitalsCard patientId={props.patientId} />
          </CardBoundary>
          <CardBoundary patientId={props.patientId} title="Labs">
            <LabsCard patientId={props.patientId} />
          </CardBoundary>
          <CardBoundary patientId={props.patientId} title="Immunizations">
            <ImmunizationsCard patientId={props.patientId} />
          </CardBoundary>
          <CardBoundary patientId={props.patientId} title="Appointments">
            <AppointmentsCard patientId={props.patientId} />
          </CardBoundary>
        </Box>
      </Row>
    </Box>
  );
}
