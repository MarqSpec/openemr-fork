import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import {Fragment, useId, useState, type ReactNode} from 'react';

import {useProblems} from '../../../api/fhir/hooks';
import type {FhirItem} from '../../../api/fhir/parse';
import type {Condition} from '../../../api/fhir/schemas';
import {hasNotEnded, wallClock, wallClockDate} from '../../../api/openemr_date';
import {EXPANDED} from '../../../theme/window_class';
import {CardItems, showsItems} from '../CardItems';
import {DashboardCard} from '../DashboardCard';

// reference: REQUIREMENTS.md FR-CARD-PRB-1, FR-CARD-4, FR-CARD-6 · INTERFACES.md API-14 ·
// REQUIREMENTS.md SCR-DASH-PRB · REQUIREMENTS.md BUG-43, BUG-46, BUG-47, BUG-51 · REQUIREMENTS.md W-5, W-12, W-12b,

/** OpenEMR's problem-list search leaves out a problem linked to an encounter (BUG-47); ruled a v1 gap, stated. */
const ENCOUNTER_NOTICE =
  'Problems linked to an encounter may not be listed here. Check OpenEMR.';

/**
 * Shown as the legacy card shows it: no end date, or one still to come (demographics.php filterActiveIssues),
 * compared as wall-clock time (BUG-51); an unreadable end date errs toward showing — one the boundary
 * rejects is a "Could not display this item" row, never dropped (FR-CARD-3). `clinicalStatus` is not used —
 * OpenEMR sends "resolved" for an open first occurrence (BUG-43).
 */
function isOpen(problem: Condition, now: Date): boolean {
  return hasNotEnded(problem.abatementDateTime, now);
}

/**
 * Where an item sorts: legacy orders by begin date, NULL first, compared as wall-clock time (BUG-51); an item
 * that did not parse has none, so last. `''` sorts before every date and `'~'` after.
 */
function onsetRank(item: FhirItem<Condition>): string {
  if (item.kind !== 'ok') return '~';
  const onset = item.resource.onsetDateTime;
  return onset === undefined ? '' : (wallClock(onset) ?? '');
}

/** Legacy's order (PatientIssuesService::search, ORDER BY lists.begdate); ties keep server order. */
function inLegacyOrder(items: FhirItem<Condition>[]): FhirItem<Condition>[] {
  return [...items].sort((a, b) => {
    const [left, right] = [onsetRank(a), onsetRank(b)];
    return left === right ? 0 : left < right ? -1 : 1;
  });
}

function titleOf(problem: Condition): string {
  const text = problem.code?.text?.trim();
  if (text !== undefined && text !== '') return text;
  return (
    problem.code?.coding?.find(coding => (coding.display ?? '') !== '')
      ?.display ?? 'Untitled problem'
  );
}

function verificationOf(problem: Condition): string | undefined {
  const coding = problem.verificationStatus?.coding?.[0];
  const words = coding?.display ?? coding?.code;
  if (words === undefined || words === '') return undefined;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the detail shows, in order — only fields API-14 returned. `clinicalStatus` is left out (it can read
 * "resolved" for an open problem, BUG-43), and so is `recordedDate` (OpenEMR fills it from the begin date).
 */
function detailOf(problem: Condition): [string, ReactNode][] {
  const fields: [string, ReactNode][] = [];
  const onset = wallClockDate(problem.onsetDateTime);
  if (onset !== undefined) fields.push(['Onset', onset]);
  const end = wallClockDate(problem.abatementDateTime);
  if (end !== undefined) fields.push(['End date', end]);
  const verification = verificationOf(problem);
  if (verification !== undefined) fields.push(['Verification', verification]);
  const codes = (problem.code?.coding ?? [])
    .filter(coding => (coding.code ?? '') !== '')
    .map(coding => `${coding.code ?? ''} ${coding.display ?? ''}`.trim());
  if (codes.length > 0) fields.push(['Code', codes.join(', ')]);
  const notes = (problem.note ?? [])
    .map(note => note.text.trim())
    .filter(text => text !== '');
  if (notes.length > 0) {
    fields.push([
      'Note',
      notes.map((text, index) => (
        <Box key={index} component="span" sx={{display: 'block'}}>
          {text}
        </Box>
      )),
    ]);
  }
  return fields;
}

/** W-12 / W-12b: centred on the expanded window class, full-screen below it; read-only. */
function ProblemDetail(props: {
  problem: Condition;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const {problem, open, onClose} = props;
  const titleId = useId();
  const fullScreen = !useMediaQuery(EXPANDED);
  const fields = detailOf(problem);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle
        component="h2"
        sx={{display: 'flex', alignItems: 'center', gap: 1}}
      >
        {fullScreen ? (
          <IconButton
            aria-label="Close"
            onClick={onClose}
            sx={{minWidth: 48, minHeight: 48}}
          >
            <span aria-hidden="true">✕</span>
          </IconButton>
        ) : null}
        <span id={titleId}>{titleOf(problem)}</span>
      </DialogTitle>
      <DialogContent>
        {fields.length === 0 ? (
          <Typography color="textSecondary">
            Nothing more is recorded for this problem.
          </Typography>
        ) : (
          <Box
            component="dl"
            sx={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 2.25,
              rowGap: 1,
              m: 0,
            }}
          >
            {fields.map(([term, value]) => (
              <Fragment key={term}>
                <Box component="dt" sx={{color: 'text.secondary'}}>
                  {term}
                </Box>
                <Box component="dd" sx={{m: 0}}>
                  {value}
                </Box>
              </Fragment>
            ))}
          </Box>
        )}
      </DialogContent>
      {fullScreen ? null : (
        <DialogActions>
          <Button onClick={onClose} sx={{minHeight: 48, minWidth: 48}}>
            Close
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
}

function ProblemRow(props: {problem: Condition}): ReactNode {
  const {problem} = props;
  const [open, setOpen] = useState(false);
  const onset = wallClockDate(problem.onsetDateTime);
  return (
    <>
      <ButtonBase
        onClick={() => {
          setOpen(true);
        }}
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          columnGap: 2,
          width: '100%',
          minHeight: 48,
          my: -0.75,
          font: 'inherit',
          textAlign: 'left',
          '&.Mui-focusVisible': {
            outline: 2,
            outlineColor: 'primary.main',
            outlineOffset: -2,
          },
        }}
      >
        <span>{titleOf(problem)}</span>
        {onset === undefined ? null : (
          <Box component="span" sx={{color: 'text.secondary'}}>
            {onset}
          </Box>
        )}
      </ButtonBase>
      {open ? (
        <ProblemDetail
          problem={problem}
          open={open}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export interface ProblemListCardProps {
  readonly patientId: string;
  /** "Now", for end dates; tests pass a fixed clock. */
  readonly clock?: () => Date;
}

/**
 * The Problem List card (SCR-DASH-PRB): open problem-list conditions in legacy order, title and onset date, each
 * opening its detail. Empty reads "Nothing Recorded" — never legacy's "None", which needs a flag OpenEMR's API does
 * not expose (BUG-46). Wherever the list or its empty wording is on screen, a notice says encounter-linked problems
 * may be missing (BUG-47); it follows CardItems' own rule, so a failed refresh drops it with the rows.
 */
export function ProblemListCard(props: ProblemListCardProps): ReactNode {
  const {patientId, clock = () => new Date()} = props;
  const query = useProblems(patientId);
  const ordered =
    query.data === undefined
      ? query
      : {...query, data: inLegacyOrder(query.data)};
  const now = clock();
  return (
    <DashboardCard
      title="Problem List"
      notice={showsItems(ordered) ? ENCOUNTER_NOTICE : undefined}
    >
      <CardItems
        query={ordered}
        subject="problems"
        emptyText="Nothing Recorded"
        include={problem => isOpen(problem, now)}
        renderItem={problem => <ProblemRow problem={problem} />}
      />
    </DashboardCard>
  );
}
