#!/usr/bin/env node
// Update every version declaration in one shot:
//   node scripts/sync-version.mjs 0.5.0
//
// This only edits files. It never tags, commits or publishes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/sync-version.mjs <MAJOR.MINOR.PATCH>');
  process.exit(2);
}

const changed = [];
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const write = (rel, body) => {
  const path = join(root, rel);
  const before = readFileSync(path, 'utf8');
  if (before === body) return;
  writeFileSync(path, body, 'utf8');
  changed.push(rel);
};

const replaceOnce = (rel, pattern, replacement, what) => {
  const before = read(rel);
  if (!pattern.test(before)) throw new Error(`${rel}: could not find ${what}`);
  write(rel, before.replace(pattern, replacement));
};

// package.json — the canonical version.
const pkg = JSON.parse(read('package.json'));
pkg.version = version;
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

// Runtime constant consumed by the CLI and MCP server.
replaceOnce('src/version.ts', /(export const VERSION = ')[^']+(')/, `$1${version}$2`, 'VERSION constant');

// MCP registry manifest (optional until committed).
if (existsSync(join(root, 'server.json'))) {
  const server = JSON.parse(read('server.json'));
  server.version = version;
  if (Array.isArray(server.packages) && server.packages[0]) server.packages[0].version = version;
  write('server.json', JSON.stringify(server, null, 2) + '\n');
}

// Composite action default (the npm version it runs).
replaceOnce(
  'action.yml',
  /(^ {2}version:\n(?: {4}.*\n)*? {4}default: ')[^']+(')/m,
  `$1${version}$2`,
  'inputs.version.default',
);

// README usage example.
replaceOnce(
  'README.md',
  /(uses: shidesheng0218\/inventory-doctor@v)\d+\.\d+\.\d+/,
  `$1${version}`,
  'GitHub Action example tag',
);

if (changed.length === 0) {
  console.log(`already at ${version}`);
} else {
  console.log(`synced ${changed.length} file(s) to ${version}:`);
  for (const file of changed) console.log(`  - ${file}`);
  console.log('Remember to commit, tag and publish separately.');
}