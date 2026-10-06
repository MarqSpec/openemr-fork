import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type {UseQueryResult} from '@tanstack/react-query';
import type {ReactNode} from 'react';

import {ApiError, type ApiFailure} from '../../api/api_error';
import type {FhirItem} from '../../api/fhir/parse';
import {fhirItemNoticeText} from './fhir_item_notice';

// reference: REQUIREMENTS.md FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// REQUIREMENTS.md W-5

export interface CardItemsProps<T> {
  /** The card's read from the API layer (`src/api/fhir/hooks.ts`). */
  readonly query: UseQueryResult<FhirItem<T>[]>;
  /** What the card lists, lower case and plural, for its messages: "Loading allergies…". */
  readonly subject: string;
  /** The legacy empty wording for this card (SCREEN_AUDIT SCR-DASH-*, FR-CARD-4). */
  readonly emptyText: string;
  readonly renderItem: (resource: T) => ReactNode;
  /** Which parsed items the card shows (e.g. active only); an item that did not parse is always shown. */
  readonly include?: (resource: T) => boolean;
}

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

/** A card read that has answered: CardItems shows its items, or the empty wording. */
type Answered<T> = Extract<UseQueryResult<FhirItem<T>[]>, {isSuccess: true}>;

/**
 * Whether {@link CardItems} shows the read's answer — its items or the empty wording — rather than loading, an
 * error or a refusal. A failed refresh counts as a failure: its error replaces the stale items. A card's
 * standing caveat about its items follows this, so it is never beside a failure nor missing beside rows.
 */
export function showsItems<T>(
  query: UseQueryResult<FhirItem<T>[]>,
): query is Answered<T> {
  return query.isSuccess;
}

/** Words for a failure a retry may fix. */
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

/**
 * A card body over its query: loading, the legacy empty wording, a not-authorised notice (403), an error with a
 * retry, or the items in server order with "Could not display this item" in place of one that did not parse, and
 * a last "More <subject> not shown" when the search said it held more than it sent (BUG-7).
 * A 401 renders nothing — the app's session-over handler owns it.
 */
export function CardItems<T>(props: CardItemsProps<T>): ReactNode {
  const {query, subject, emptyText, renderItem, include} = props;

  if (query.isPending) {
    if (query.fetchStatus === 'idle') return null;
    return (
      <Box aria-busy="true">
        <Box component="span" sx={VISUALLY_HIDDEN}>
          Loading {subject}…
        </Box>
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="70%" />
      </Box>
    );
  }

  if (!showsItems(query)) {
    const failure =
      query.error instanceof ApiError ? query.error.failure : undefined;
    if (failure?.kind === 'session-over') return null;
    if (failure?.kind === 'not-authorised') {
      return (
        <Alert severity="warning">
          You&apos;re not authorised to view {subject}. Access is controlled in
          OpenEMR.
        </Alert>
      );
    }
    return (
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
        Couldn&apos;t load {subject}
        {failureDetail(failure)}.
      </Alert>
    );
  }

  const items = query.data.filter(
    item =>
      item.kind !== 'ok' || include === undefined || include(item.resource),
  );
  if (items.length === 0) {
    return <Typography color="textSecondary">{emptyText}</Typography>;
  }
  return (
    <Box component="ul" sx={{listStyle: 'none', m: 0, p: 0}}>
      {items.map((item, index) => (
        <Box
          component="li"
          // Server order is stable, and an item that did not parse has no id to key on.
          key={index}
          sx={{
            py: 0.75,
            borderTop: index === 0 ? 0 : 1,
            borderColor: 'divider',
          }}
        >
          {item.kind === 'ok' ? (
            renderItem(item.resource)
          ) : (
            <Typography component="span" color="textSecondary">
              <span aria-hidden="true">⚠ </span>
              {fhirItemNoticeText(item.kind, subject)}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}
