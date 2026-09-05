import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Store config. Credentials may be written inline or referenced as
// "env:VAR_NAME" so secrets never have to live in the file.
export interface StoreConfig {
  name: string;
  domain: string; // e.g. "my-store.myshopify.com"
  // Mode 1: existing static token (shpat_...)
  accessToken?: string;
  // Mode 2: client credentials grant (new apps since 2026-01)
  clientId?: string;
  clientSecret?: string;
}

export interface AppConfig {
  stores: StoreConfig[];
}

const DEFAULT_CONFIG_PATHS = [
  'inventory-doctor.json',
  join(homedir(), '.config', 'inventory-doctor', 'config.json'),
];

export async function loadConfig(explicitPath?: string): Promise<AppConfig> {
  const path = explicitPath ?? DEFAULT_CONFIG_PATHS.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      'No config file found. Create inventory-doctor.json or pass --config. ' +
        'See README for the store configuration format.',
    );
  }
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as AppConfig;
  if (!Array.isArray(parsed.stores)) {
    throw new Error(`Invalid config at ${path}: missing "stores" array.`);
  }
  for (const store of parsed.stores) {
    validateStore(store, path);
  }
  return parsed;
}

function validateStore(store: StoreConfig, path: string): void {
  if (!store.name || !store.domain) {
    throw new Error(`Invalid store entry in ${path}: each store needs "name" and "domain".`);
  }
  const hasStatic = Boolean(store.accessToken);
  const hasClientCreds = Boolean(store.clientId && store.clientSecret);
  if (!hasStatic && !hasClientCreds) {
    throw new Error(
      `Store "${store.name}" in ${path} has no credentials: set either "accessToken" or both "clientId" and "clientSecret".`,
    );
  }
}

export function findStore(config: AppConfig, name: string): StoreConfig {
  const store = config.stores.find((s) => s.name === name);
  if (!store) {
    throw new Error(`Store "${name}" not found in config. Available: ${config.stores.map((s) => s.name).join(', ')}`);
  }
  return store;
}

// Resolve a config value that may be "env:VAR_NAME" against process.env.
export function resolveSecret(value: string): string {
  if (value.startsWith('env:')) {
    const varName = value.slice('env:'.length);
    const resolved = process.env[varName];
    if (resolved === undefined || resolved === '') {
      throw new Error(`Environment variable ${varName} is not set (referenced as "${value}").`);
    }
    return resolved;
  }
  return value;
}
