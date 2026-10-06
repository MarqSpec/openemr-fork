/**
 * Regenerates public/icons/ from OpenEMR's menu logo: `npm run icons` (Node 22.18+ runs the TypeScript as is).
 * The PNGs are committed, so a build never needs this; icon_set.test.ts fails if they drift from its output.
 */
import {mkdirSync, writeFileSync} from 'node:fs';

import {
  ICON_DIR_URL,
  ICON_SPECS,
  committedIconPath,
  readSourceLogo,
  renderIcon,
} from './icon_set.ts';

const source = readSourceLogo();
mkdirSync(ICON_DIR_URL, {recursive: true});
for (const spec of ICON_SPECS) {
  writeFileSync(committedIconPath(spec), renderIcon(spec, source).png);
  console.log(`wrote public/icons/${spec.file} (${String(spec.size)}px)`);
}
