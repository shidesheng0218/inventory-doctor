#!/usr/bin/env node
// Verify that every place that declares the project version agrees with
// package.json. Run in CI (and before publish) so release metadata cannot
// drift again.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const failures = [];
const notes = [];

const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: found ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  failures.push(`package.json version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`);
}

const versionTs = read('src/version.ts').match(/export const VERSION = '([^']+)'/)?.[1];
expect('src/version.ts VERSION', versionTs, version);

// Optional distribution manifests. They may be absent in a fresh clone while
// the release is being prepared; when present they must match.
if (existsSync(join(root, 'server.json'))) {
  const server = JSON.parse(read('server.json'));
  expect('server.json version', server.version, version);
  expect('server.json packages[0].version', server.packages?.[0]?.version, version);
} else {
  notes.push('server.json not present — skipped');
}

const action = read('action.yml');
const actionDefault = action.match(/^ {2}version:\n(?: {4}.*\n)*? {4}default: '([^']+)'/m)?.[1];
expect('action.yml inputs.version.default', actionDefault, version);

const readmeTag = read('README.md').match(/uses: shidesheng0218\/inventory-doctor@v(\d+\.\d+\.\d+)/)?.[1];
expect('README.md action example tag', readmeTag, version);

// Runtime code must not hardcode a version of its own.
for (const file of ['src/cli.ts', 'src/mcp.ts']) {
  const body = read(file);
  const hardcoded = body.match(/\.version\('(\d+\.\d+\.\d+)'\)|version: '(\d+\.\d+\.\d+)'/);
  if (hardcoded) failures.push(`${file} hardcodes version ${JSON.stringify(hardcoded[0])}; import VERSION from src/version.ts`);
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
  console.error('Version metadata is inconsistent:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('Run: node scripts/sync-version.mjs <version>');
  process.exit(1);
}
console.log(`version metadata consistent: ${version}`);