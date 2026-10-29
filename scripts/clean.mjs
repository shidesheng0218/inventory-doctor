// Remove the build output before compiling. tsc never deletes files for
// sources that no longer exist, so without this a stale dist/ (renamed or
// deleted modules) ships in the npm package.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true });