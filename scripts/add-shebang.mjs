// Post-build step: tsc does not emit a shebang banner, so prepend it to
// dist/cli.js after every build.
import { readFileSync, writeFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node\n';
const path = new URL('../dist/cli.js', import.meta.url);

const content = readFileSync(path, 'utf8');
if (!content.startsWith('#!')) {
  writeFileSync(path, SHEBANG + content);
  console.error('add-shebang: prepended to dist/cli.js');
} else {
  console.error('add-shebang: already present, skipped');
}
