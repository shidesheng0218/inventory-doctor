import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RULES } from './core/diagnose.js';
import { normalizeSku } from './core/normalize.js';
import type { BundleDef, Severity } from './core/types.js';

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
  // Mode 3: offline token from "inventory-doctor auth <domain>" (agency / cross-org)
  oauth?: boolean;
}

// WooCommerce store config (REST API v3, consumer key/secret).
export interface WooStoreConfig {
  name: string;
  baseUrl: string; // e.g. "https://shop.example.com"
  consumerKey: string;
  consumerSecret: string;
}

// Rule-level knobs. CLI flags (--drift-abs / --drift-pct) win over these.
export interface RulesConfig {
  disable?: string[]; // rule ids to turn off
  ignoreSkus?: string[]; // glob patterns matched against the canonical SKU
  severityOverrides?: Record<string, Severity>; // rule id → forced severity
  driftAbsThreshold?: number;
  driftPctThreshold?: number;
}

// Notification targets. The CLI flag wins when both are set.
export interface NotifyConfig {
  webhookUrl?: string; // POST target for snapshot-check critical alerts
}

export interface AppConfig {
  stores: StoreConfig[];
  woocommerce?: WooStoreConfig[];
  rules?: RulesConfig;
  bundles?: BundleDef[]; // bundle kit definitions for the bundle-availability rule
  notify?: NotifyConfig;
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
  for (const woo of parsed.woocommerce ?? []) {
    if (!woo.name || !woo.baseUrl || !woo.consumerKey || !woo.consumerSecret) {
      throw new Error(
        `Invalid WooCommerce entry in ${path}: each entry needs "name", "baseUrl", "consumerKey", and "consumerSecret".`,
      );
    }
  }
  if (parsed.rules !== undefined) {
    validateRules(parsed.rules, path);
  }
  if (parsed.bundles !== undefined) {
    validateBundles(parsed.bundles, path);
  }
  if (parsed.notify !== undefined) {
    const webhookUrl = parsed.notify.webhookUrl;
    if (webhookUrl !== undefined && typeof webhookUrl !== 'string') {
      throw new Error(`Invalid config at ${path}: notify.webhookUrl must be a string.`);
    }
  }
  return parsed;
}

// Like loadConfig, but CSV-only runs may legitimately have no config file:
// returns null instead of throwing when none exists. A file that EXISTS but
// is invalid still throws — silent misconfiguration is worse than no config.
export async function loadConfigIfExists(explicitPath?: string): Promise<AppConfig | null> {
  const path = explicitPath ?? DEFAULT_CONFIG_PATHS.find((p) => existsSync(p));
  if (!path || !existsSync(path)) return null;
  return loadConfig(path);
}

const SEVERITIES = ['critical', 'warning', 'info'];

// Fail-loud: a malformed bundle definition must not be silently skipped by
// the rule — a wrong kit config means wrong availability math.
export function validateBundles(bundles: unknown, path: string): asserts bundles is BundleDef[] {
  if (!Array.isArray(bundles)) {
    throw new Error(`Invalid config at ${path}: "bundles" must be an array.`);
  }
  const seen = new Set<string>();
  for (const bundle of bundles) {
    const sku = typeof bundle?.sku === 'string' && bundle.sku.trim() !== '' ? bundle.sku : null;
    if (sku === null) {
      throw new Error(`Invalid config at ${path}: every bundle entry needs a non-empty "sku".`);
    }
    const canonical = normalizeSku(sku).canonical;
    if (seen.has(canonical)) {
      throw new Error(`Invalid config at ${path}: bundle sku "${sku}" is defined more than once.`);
    }
    seen.add(canonical);

    if (!Array.isArray(bundle.components) || bundle.components.length === 0) {
      throw new Error(`Invalid config at ${path}: bundle "${sku}" must list at least one component.`);
    }
    for (const component of bundle.components) {
      const componentSku = typeof component?.sku === 'string' && component.sku.trim() !== '' ? component.sku : null;
      if (componentSku === null) {
        throw new Error(`Invalid config at ${path}: bundle "${sku}" has a component without a "sku".`);
      }
      if (!Number.isInteger(component.quantity) || component.quantity < 1) {
        throw new Error(
          `Invalid config at ${path}: bundle "${sku}": component "${componentSku}" quantity must be an integer >= 1 (got ${JSON.stringify(component.quantity)}).`,
        );
      }
    }
  }
}

function validateRules(rules: RulesConfig, path: string): void {
  const badRule = (id: string) => !(RULES as readonly string[]).includes(id);
  for (const id of rules.disable ?? []) {
    if (badRule(id)) throw new Error(`Invalid config at ${path}: unknown rule "${id}" in rules.disable. Known: ${RULES.join(', ')}`);
  }
  for (const [id, severity] of Object.entries(rules.severityOverrides ?? {})) {
    if (badRule(id)) throw new Error(`Invalid config at ${path}: unknown rule "${id}" in rules.severityOverrides.`);
    if (!SEVERITIES.includes(severity)) {
      throw new Error(`Invalid config at ${path}: severity for "${id}" must be one of ${SEVERITIES.join(', ')}.`);
    }
  }
  for (const [key, value] of [['driftAbsThreshold', rules.driftAbsThreshold], ['driftPctThreshold', rules.driftPctThreshold]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid config at ${path}: rules.${key} must be a non-negative number.`);
    }
  }
}

function validateStore(store: StoreConfig, path: string): void {
  if (!store.name || !store.domain) {
    throw new Error(`Invalid store entry in ${path}: each store needs "name" and "domain".`);
  }
  const hasStatic = Boolean(store.accessToken);
  const hasClientCreds = Boolean(store.clientId && store.clientSecret);
  if (!hasStatic && !hasClientCreds && store.oauth !== true) {
    throw new Error(
      `Store "${store.name}" in ${path} has no credentials: set "accessToken", both "clientId" and "clientSecret", or "oauth": true.`,
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

export function findWooStore(config: AppConfig, name: string): WooStoreConfig {
  const store = (config.woocommerce ?? []).find((s) => s.name === name);
  if (!store) {
    throw new Error(
      `WooCommerce store "${name}" not found in config. Available: ${(config.woocommerce ?? []).map((s) => s.name).join(', ') || '(none)'}`,
    );
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
