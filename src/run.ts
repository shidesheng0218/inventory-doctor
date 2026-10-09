import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DiagnoseOptions, DiagnoseReport, Finding, InventoryRecord } from './core/types.js';
import { DEFAULT_DIAGNOSE_OPTIONS } from './core/types.js';
import { diagnose } from './core/diagnose.js';
import { normalizeSku } from './core/normalize.js';
import { loadCsv, type CsvAdapterResult } from './adapters/csv/index.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { findStore, findWooStore, loadConfig, loadConfigIfExists, resolveSecret } from './config.js';
import { tokenProviderFor } from './adapters/shopify-api/token-provider.js';
import { ShopifyClient } from './adapters/shopify-api/client.js';
import { fetchInventory } from './adapters/shopify-api/fetch-inventory.js';
import { WooClient } from './adapters/woocommerce/client.js';
import { fetchWooInventory } from './adapters/woocommerce/fetch-inventory.js';
import { listSnapshotStubs, loadSnapshot, loadSnapshotWindow } from './snapshots.js';
import { nightlyZero } from './core/rules/nightly-zero.js';

export type SourceInput =
  | { kind: 'csv'; path: string; name?: string }
  | { kind: 'store'; name: string }
  | { kind: 'woo'; name: string }
  | { kind: 'snapshot'; ref: string };

// A source argument on the command line or in MCP is either a CSV file path,
// "store:<name>" (a Shopify store from inventory-doctor.json), "woo:<name>"
// (a WooCommerce store from the same file), or "snapshot:<ref>"
// (a saved snapshot — "<name>", "<name>@<id>", or a file path).
export function parseSourceArg(value: string): SourceInput {
  if (value.startsWith('store:')) {
    const name = value.slice('store:'.length).trim();
    if (name === '') throw new Error('source "store:" is missing the store name, expected "store:<name>"');
    return { kind: 'store', name };
  }
  if (value.startsWith('woo:')) {
    const name = value.slice('woo:'.length).trim();
    if (name === '') throw new Error('source "woo:" is missing the store name, expected "woo:<name>"');
    return { kind: 'woo', name };
  }
  if (value.startsWith('snapshot:')) {
    const ref = value.slice('snapshot:'.length).trim();
    if (ref === '') throw new Error('source "snapshot:" is missing the reference, expected "snapshot:<name>[@<id>]"');
    return { kind: 'snapshot', ref };
  }
  return { kind: 'csv', path: value };
}

export interface LoadedSource {
  name: string;
  records: InventoryRecord[];
  detail: string; // e.g. detected CSV format, shown to the user
}

export interface LoadOptions {
  configPath?: string | undefined;
  columnMapping?: ColumnMapping | undefined;
}

export async function loadSource(input: SourceInput, options: LoadOptions = {}): Promise<LoadedSource> {
  const loaded = await loadSourceUnchecked(input, options);
  // A source with zero records makes every comparison vacuous — the report
  // would show "health 100, no findings" over nothing. Fail loudly instead.
  if (loaded.records.length === 0) {
    const hint =
      input.kind === 'csv'
        ? ' The file may be empty, have a header row but no data rows, or have a blank SKU column; for unrecognized layouts pass --map (see diff --help).'
        : ' Check that the source actually contains inventory data.';
    throw new Error(`Source "${loaded.name}" loaded 0 records — nothing to diagnose.${hint}`);
  }
  return loaded;
}

async function loadSourceUnchecked(input: SourceInput, options: LoadOptions): Promise<LoadedSource> {
  if (input.kind === 'csv') {
    let content: string;
    try {
      content = await readFile(input.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`CSV file not found: ${input.path}`);
      }
      throw err;
    }
    const name = input.name ?? basename(input.path).replace(/\.(csv|tsv|txt)$/i, '');
    const result: CsvAdapterResult = loadCsv(content, name, options.columnMapping ?? {});
    return { name, records: result.records, detail: result.detection.reason };
  }

  if (input.kind === 'snapshot') {
    const snapshot = await loadSnapshot(input.ref);
    return {
      name: `${snapshot.name}@${snapshot.id}`,
      records: snapshot.records,
      detail: `snapshot saved ${snapshot.savedAt} (${snapshot.recordCount} records)`,
    };
  }

  if (input.kind === 'woo') {
    const config = await loadConfig(options.configPath);
    const store = findWooStore(config, input.name);
    const client = new WooClient({
      baseUrl: store.baseUrl,
      consumerKey: resolveSecret(store.consumerKey),
      consumerSecret: resolveSecret(store.consumerSecret),
    });
    const records = await fetchWooInventory(client, store.name);
    return { name: store.name, records, detail: `WooCommerce REST API (${store.baseUrl})` };
  }

  const config = await loadConfig(options.configPath);
  const store = findStore(config, input.name);
  const provider = tokenProviderFor({
    domain: store.domain,
    accessToken: store.accessToken ? resolveSecret(store.accessToken) : undefined,
    clientId: store.clientId ? resolveSecret(store.clientId) : undefined,
    clientSecret: store.clientSecret ? resolveSecret(store.clientSecret) : undefined,
    oauth: store.oauth,
  });
  const client = new ShopifyClient({ domain: store.domain, tokenProvider: provider });
  const records = await fetchInventory(client, store.name);
  return { name: store.name, records, detail: `Shopify Admin API (${store.domain})` };
}

export async function runDiff(
  inputs: [SourceInput, SourceInput],
  options: LoadOptions & { diagnose?: Partial<DiagnoseOptions> } = {},
): Promise<{ report: DiagnoseReport; sources: LoadedSource[] }> {
  const loaded = await Promise.all(inputs.map((input) => loadSource(input, options)));
  const records = loaded.flatMap((s) => s.records);
  const diagnoseOptions = await resolveDiagnoseOptions(options);
  return { report: diagnose(records, diagnoseOptions), sources: loaded };
}

// Merge precedence: built-in defaults < inventory-doctor.json "rules" < CLI flags.
async function resolveDiagnoseOptions(
  options: LoadOptions & { diagnose?: Partial<DiagnoseOptions> },
): Promise<DiagnoseOptions> {
  const config = await loadConfigIfExists(options.configPath);
  const rules = config?.rules;
  return {
    ...DEFAULT_DIAGNOSE_OPTIONS,
    ...(rules?.driftAbsThreshold !== undefined ? { driftAbsThreshold: rules.driftAbsThreshold } : {}),
    ...(rules?.driftPctThreshold !== undefined ? { driftPctThreshold: rules.driftPctThreshold } : {}),
    ...(rules?.disable !== undefined ? { disabledRules: rules.disable } : {}),
    ...(rules?.ignoreSkus !== undefined ? { ignoreSkus: rules.ignoreSkus } : {}),
    ...(rules?.severityOverrides !== undefined ? { severityOverrides: rules.severityOverrides } : {}),
    ...options.diagnose, // explicit CLI flags last — they win
  };
}

export interface SkuExplanation {
  sku: string;
  canonical: string;
  found: boolean;
  perSource: Array<{
    source: string;
    matched: boolean;
    records: Array<{
      sku: string | null;
      barcode: string | null;
      title: string | null;
      location: string | null;
      quantity: number | null;
      quantityRaw: string;
      tracked: boolean | null;
    }>;
  }>;
  findings: Array<{ rule: string; severity: string; message: string; suggestion: string }>;
}

// Detail view for one SKU across all sources — what agents ask as a follow-up.
export async function explainSku(
  sku: string,
  inputs: SourceInput[],
  options: LoadOptions = {},
): Promise<SkuExplanation> {
  const loaded = await Promise.all(inputs.map((input) => loadSource(input, options)));
  const canonical = normalizeSku(sku).canonical;

  const perSource = loaded.map((s) => {
    const matched = s.records.filter(
      (r) => r.sku !== null && normalizeSku(r.sku).canonical === canonical,
    );
    return {
      source: s.name,
      matched: matched.length > 0,
      records: matched.map((r) => ({
        sku: r.sku,
        barcode: r.barcode,
        title: r.title,
        location: r.location,
        quantity: r.quantity,
        quantityRaw: r.quantityRaw,
        tracked: r.tracked,
      })),
    };
  });

  const allRecords = loaded.flatMap((s) => s.records);
  const report = diagnose(allRecords, await resolveDiagnoseOptions(options));
  const findings = report.findings
    .filter((f) => f.sku !== null && normalizeSku(f.sku).canonical === canonical)
    .map((f) => ({ rule: f.rule, severity: f.severity, message: f.message, suggestion: f.suggestion }));

  return {
    sku,
    canonical,
    found: perSource.some((s) => s.matched),
    perSource,
    findings,
  };
}

export interface HealthResult {
  sources: string[];
  recordCounts: Record<string, number>;
  healthScore: number;
  healthSummary: DiagnoseReport['healthSummary'];
  countsBySeverity: Record<'critical' | 'warning' | 'info', number>;
}

// Lightweight summary without the full findings list.
export async function inventoryHealth(
  inputs: SourceInput[],
  options: LoadOptions = {},
): Promise<HealthResult> {
  const loaded = await Promise.all(inputs.map((input) => loadSource(input, options)));
  const report = diagnose(loaded.flatMap((s) => s.records), await resolveDiagnoseOptions(options));
  const countsBySeverity = { critical: 0, warning: 0, info: 0 };
  for (const f of report.findings) countsBySeverity[f.severity] += 1;
  return {
    sources: report.sources,
    recordCounts: report.recordCounts,
    healthScore: report.healthScore,
    healthSummary: report.healthSummary,
    countsBySeverity,
  };
}

export interface SnapshotCheckOptions {
  // Load only the newest N snapshots.
  //
  // Retention and detection are different questions: history can be kept for a
  // year while the rule only cares about the recent past. Every loaded record
  // costs ~300 bytes in memory, so comparing 365 daily snapshots of a
  // 5,000-SKU shop would need ~510 MB. A window keeps a long-running install
  // flat instead of growing until it runs out of memory.
  maxSnapshots?: number;
}

export interface SnapshotCheckResult {
  name: string;
  /** The snapshots that were actually read (the window, when one applied). */
  snapshots: Array<{ id: string; savedAt: string; recordCount: number }>;
  /** Total snapshots on disk, whether or not they were loaded. */
  totalSnapshots: number;
  /** True when only the newest part of the history was loaded. */
  windowed: boolean;
  findings: Finding[];
}

// Time-series check over the saved snapshots of one source. Runs only the
// nightly-zero rule — the cross-source rules are meaningless when every
// "source" is the same inventory at a different time.
export async function runSnapshotCheck(
  name: string,
  options: SnapshotCheckOptions = {},
): Promise<SnapshotCheckResult> {
  const stubs = await listSnapshotStubs(name);
  const loaded = await loadSnapshotWindow(name, options.maxSnapshots);
  return {
    name,
    snapshots: loaded.map((s) => ({ id: s.id, savedAt: s.savedAt, recordCount: s.recordCount })),
    totalSnapshots: stubs.length,
    windowed: loaded.length < stubs.length,
    findings: nightlyZero(loaded.flatMap((s) => s.records)),
  };
}
