import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import {useId, type ReactNode} from 'react';

import {launchUrl, type PatientApp} from './patient_apps';

// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1, NFR-A11Y-1 · REQUIREMENTS.md
// W-13 · REQUIREMENTS.md BUG-24, BUG-25

export interface PatientAppsProps {
  readonly patientId: string;
  readonly apps: readonly PatientApp[];
}

/**
 * The patient-apps slot: one link per configured app, each opening that app's launch for this patient in a new
 * top-level tab — never an iframe, whose cookies OpenEMR's launch cannot rely on (BUG-25). Nothing when none is set.
 */
export function PatientApps(props: PatientAppsProps): ReactNode {
  const labelId = useId();
  const noteId = useId();
  const hintIdBase = useId();
  if (props.apps.length === 0) return null;

  return (
    <Box
      role="group"
      aria-labelledby={labelId}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 2,
        rowGap: 1,
        px: 2,
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Typography id={labelId} variant="overline" component="span">
        Patient apps
      </Typography>
      {props.apps.map((app, index) => {
        const hintId = `${hintIdBase}-${String(index)}`;
        return (
          <Box
            key={`${app.label}-${String(index)}`}
            sx={{display: 'flex', alignItems: 'center', columnGap: 1}}
          >
            <Button
              component="a"
              href={launchUrl(app.url, props.patientId)}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              aria-label={`${app.label} — opens in a new tab`}
              aria-describedby={
                app.aclHint === undefined ? noteId : `${noteId} ${hintId}`
              }
              sx={{minHeight: 48}}
            >
              {app.label}
              <Box component="span" aria-hidden="true" sx={{ml: 0.5}}>
                ↗
              </Box>
            </Button>
            {app.aclHint === undefined ? null : (
              <Typography
                id={hintId}
                variant="caption"
                color="textSecondary"
                component="span"
              >
                Needs OpenEMR access: {app.aclHint}
              </Typography>
            )}
          </Box>
        );
      })}
      <Typography
        id={noteId}
        variant="caption"
        color="textSecondary"
        component="span"
      >
        OpenEMR may ask you to sign in first.
      </Typography>
    </Box>
  );
}
