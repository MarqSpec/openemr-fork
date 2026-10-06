import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from 'react';
import {ErrorBoundary} from 'react-error-boundary';

// reference: REQUIREMENTS.md FR-CARD-1, NFR-A11Y-1, NFR-A11Y-2 · REQUIREMENTS.md §5.2 ·
// REQUIREMENTS.md W-3, W-5

/** The patient the enclosing {@link CardBoundary} shows, so a card's body boundary resets with it too. */
const CardPatientContext = createContext<string | undefined>(undefined);

/** What a card shows when it threw while rendering: its own failure, with a retry, never a blank dashboard. */
function CardFailed(props: {onRetry: () => void}): ReactNode {
  return (
    <Alert
      severity="error"
      action={
        <Button
          color="inherit"
          sx={{minHeight: 48, minWidth: 48}}
          onClick={props.onRetry}
        >
          Try again
        </Button>
      }
    >
      Couldn&apos;t display this card.
    </Alert>
  );
}

export interface DashboardCardProps {
  readonly title: string;
  /** The body; usually {@link CardItems} over the card's query. */
  readonly children: ReactNode;
  /** A standing caveat, in words, shown under the body and describing the region; omit it where it would mislead. */
  readonly notice?: string | undefined;
}

/**
 * One dashboard card: a region named by its title, whose level-2 heading is the collapse control (the legacy
 * card toggles from its title too), and an error boundary so a card that throws never takes the dashboard down.
 * Collapse state lasts while the card is mounted; persisting it per device is FR-CARD-2.
 */
export function DashboardCard(props: DashboardCardProps): ReactNode {
  const {title, children, notice} = props;
  const headingId = useId();
  const bodyId = useId();
  const noticeId = useId();
  const [expanded, setExpanded] = useState(true);
  const patientId = useContext(CardPatientContext);

  return (
    <Paper
      component="section"
      aria-labelledby={headingId}
      aria-describedby={notice === undefined ? undefined : noticeId}
      square
      elevation={0}
      sx={{border: 1, borderColor: 'divider', minWidth: 0}}
    >
      <Typography
        component="h2"
        id={headingId}
        sx={{fontSize: '1rem', fontWeight: 700, m: 0}}
      >
        <ButtonBase
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => {
            setExpanded(open => !open);
          }}
          sx={{
            minHeight: 48,
            width: '100%',
            justifyContent: 'flex-start',
            gap: 1,
            px: 1.5,
            font: 'inherit',
            textAlign: 'left',
            '&.Mui-focusVisible': {
              outline: 2,
              outlineColor: 'primary.main',
              outlineOffset: -2,
            },
          }}
        >
          <Box
            component="span"
            aria-hidden="true"
            sx={{
              display: 'inline-block',
              transition: 'transform 150ms',
              transform: expanded ? 'none' : 'rotate(-90deg)',
            }}
          >
            ▾
          </Box>
          {title}
        </ButtonBase>
      </Typography>
      <Box id={bodyId} hidden={!expanded} sx={{px: 1.5, pb: 1.5}}>
        <ErrorBoundary
          resetKeys={[patientId]}
          fallbackRender={({resetErrorBoundary}) => (
            <CardFailed onRetry={resetErrorBoundary} />
          )}
        >
          {children}
          {notice === undefined ? null : (
            <Typography
              id={noticeId}
              variant="body2"
              color="textSecondary"
              sx={{mt: 1}}
            >
              {notice}
            </Typography>
          )}
        </ErrorBoundary>
      </Box>
    </Paper>
  );
}

export interface CardBoundaryProps {
  /** The title of the card inside, kept on its failure so the dashboard still reads in legacy order. */
  readonly title: string;
  /** The patient the card shows: a change clears a failure, here and in the card's body, without a remount. */
  readonly patientId: string;
  readonly children: ReactNode;
}

/**
 * Wraps a whole card, its data hook included: a throw before the card's own frame renders becomes that card's
 * failure under its title, never the dashboard's (FR-CARD-1). Every dashboard slot sits in one. A failure is the
 * patient's it happened for: when the patient changes, the card tries again.
 */
export function CardBoundary(props: CardBoundaryProps): ReactNode {
  return (
    <CardPatientContext value={props.patientId}>
      <ErrorBoundary
        resetKeys={[props.patientId]}
        fallbackRender={({resetErrorBoundary}) => (
          <DashboardCard title={props.title}>
            <CardFailed onRetry={resetErrorBoundary} />
          </DashboardCard>
        )}
      >
        {props.children}
      </ErrorBoundary>
    </CardPatientContext>
  );
}
