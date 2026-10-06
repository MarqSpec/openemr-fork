import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import {useId, useState} from 'react';

import type {ThemePreference} from './theme_preference';
import {TOUCH_TARGET} from './tokens';

interface ThemeOption {
  readonly value: ThemePreference;
  readonly label: string;
  readonly glyph: string;
}

const OPTIONS: readonly ThemeOption[] = [
  {value: 'light', label: 'Light', glyph: '☀'},
  {value: 'dark', label: 'Dark', glyph: '☾'},
  {value: 'system', label: 'Match device', glyph: '◐'},
];

interface ThemeMenuProps {
  readonly preference: ThemePreference;
  readonly onChange: (preference: ThemePreference) => void;
}

/** Light · Dark · Match device selector (FR-UI-2, wireframe W-9). */
export function ThemeMenu({preference, onChange}: ThemeMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();

  return (
    <>
      <IconButton
        aria-label="Theme"
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? 'true' : undefined}
        onClick={event => {
          setAnchor(event.currentTarget);
        }}
        sx={{width: TOUCH_TARGET, height: TOUCH_TARGET}}
      >
        <span aria-hidden="true">◐</span>
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
      >
        {OPTIONS.map(option => (
          <MenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={preference === option.value}
            selected={preference === option.value}
            onClick={() => {
              onChange(option.value);
              setAnchor(null);
            }}
            // MenuItem drops to `minHeight: auto` from the sm breakpoint up; the tablet target stays 48 dp.
            sx={{minHeight: {xs: TOUCH_TARGET, sm: TOUCH_TARGET}}}
          >
            <ListItemIcon aria-hidden="true">{option.glyph}</ListItemIcon>
            <ListItemText>{option.label}</ListItemText>
            {/* The selection must not rely on the background tint alone (NFR-A11Y-1). */}
            {preference === option.value && (
              <Box
                component="span"
                aria-hidden="true"
                sx={{ml: 2, fontWeight: 'fontWeightBold'}}
              >
                ✓
              </Box>
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
