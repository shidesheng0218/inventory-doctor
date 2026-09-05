import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DiagnoseOptions, DiagnoseReport, InventoryRecord } from './core/types.js';
import { DEFAULT_DIAGNOSE_OPTIONS } from './core/types.js';
import { diagnose } from './core/diagnose.js';
import { normalizeSku } from './core/normalize.js';
import { loadCsv, type CsvAdapterResult } from './adapters/csv/index.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { findStore, loadConfig, resolveSecret } from './config.js';
import { tokenProviderFor } from './adapters/shopify-api/token-provider.js';
import { ShopifyClient } from './adapters/shopify-api/client.js';
import { fetchInventory } from './adapters/shopify-api/fetch-inventory.js';

export type SourceInput =
  | { kind: 'csv'; path: string; name?: string }
  | { kind: 'store'; name: string };

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
  if (input.kind === 'csv') {
    const content = await readFile(input.path, 'utf8');
    const name = input.name ?? basename(input.path).replace(/\.(csv|tsv|txt)$/i, '');
    const result: CsvAdapterResult = loadCsv(content, name, options.columnMapping ?? {});
    return { name, records: result.records, detail: result.detection.reason };
  }

  const config = await loadConfig(options.configPath);
  const store = findStore(config, input.name);
  const provider = tokenProviderFor({
    domain: store.domain,
    accessToken: store.accessToken ? resolveSecret(store.accessToken) : undefined,
    clientId: store.clientId ? resolveSecret(store.clientId) : undefined,
    clientSecret: store.clientSecret ? resolveSecret(store.clientSecret) : undefined,
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
  const diagnoseOptions: DiagnoseOptions = { ...DEFAULT_DIAGNOSE_OPTIONS, ...options.diagnose };
  return { report: diagnose(records, diagnoseOptions), sources: loaded };
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
  const report = diagnose(allRecords);
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
  const report = diagnose(loaded.flatMap((s) => s.records));
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
