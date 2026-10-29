import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { explainSku, inventoryHealth, parseSourceArg, runDiff, runSnapshotCheck } from './run.js';
import { skuHistory } from './history.js';
import { buildFixExport } from './report/fix-export.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { VERSION } from './version.js';

export { parseSourceArg };

// MCP entry point. stdout is the JSON-RPC channel: NOTHING may write to it
// except the SDK transport. All logging goes to console.error (stderr).
// Every log line in this file and its imports must honor that.

// A source argument is a CSV file path, "store:<name>" (resolved through the
// config file + env-referenced credentials), or "snapshot:<name>[@<id>]".
// Parsing lives in run.ts so the CLI and MCP share one definition.
const SOURCE_DESC = 'CSV file path, "store:<name>" for a configured Shopify store, "woo:<name>" for a configured WooCommerce store, or "snapshot:<name>[@<id>]" for a saved snapshot';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const PAGE_DESC = 'Non-negative zero-based offset into the result page.';
const pageSize = (value: number | undefined): number => value ?? DEFAULT_PAGE_SIZE;
const page = <T>(items: T[], offset: number, maxItems: number) => {
  const sliced = items.slice(offset, offset + maxItems);
  const truncated = offset + sliced.length < items.length;
  return { items: sliced, total: items.length, truncated, ...(truncated ? { nextOffset: offset + sliced.length } : {}) };
};
const mappingSchema = z.object({ sku: z.string().optional(), quantity: z.string().optional(), barcode: z.string().optional(), title: z.string().optional(), location: z.string().optional() }).strict().optional().describe('Explicit CSV header mapping for unrecognized layouts');
const diagnoseSchema = {
  driftAbs: z.number().finite().nonnegative().optional().describe('Absolute drift threshold override'),
  driftPct: z.number().finite().nonnegative().optional().describe('Percentage drift threshold override'),
};
const diagnoseArgs = (driftAbs: number | undefined, driftPct: number | undefined) => ({ ...(driftAbs === undefined ? {} : { driftAbsThreshold: driftAbs }), ...(driftPct === undefined ? {} : { driftPctThreshold: driftPct }) });
function mappedColumns(mapping: z.infer<typeof mappingSchema>): ColumnMapping | undefined {
  if (mapping === undefined) return undefined;
  const result: ColumnMapping = {};
  for (const key of ['sku', 'quantity', 'barcode', 'title', 'location'] as const) {
    if (mapping[key] !== undefined) result[key] = mapping[key];
  }
  return result;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'inventory-doctor', version: VERSION });

  server.tool(
    'diff_inventory',
    'Compare two CSV, Shopify, WooCommerce or snapshot sources. Return observed differences and conditional risks, not confirmed incidents; findings include evidence, risk, assumptions and verification. Findings are capped (maxFindings) to keep the payload small; use explain_sku for per-SKU follow-ups.',
    {
      sourceA: z.string().describe(SOURCE_DESC),
      sourceB: z.string().describe(SOURCE_DESC),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (optional; config can also tune diagnostic rules)'),
      columnMapping: mappingSchema,
      ...diagnoseSchema,
      maxFindings: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap on findings returned (default 100)'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe(PAGE_DESC),
    },
    async ({ sourceA, sourceB, configPath, columnMapping, driftAbs, driftPct, maxFindings, offset = 0 }) => {
      const { report } = await runDiff([parseSourceArg(sourceA), parseSourceArg(sourceB)], { configPath, columnMapping: mappedColumns(columnMapping), diagnose: diagnoseArgs(driftAbs, driftPct) });
      const result = page(report.findings, offset, pageSize(maxFindings));
      if (!result.truncated && offset === 0) return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      const payload = { ...report, findings: result.items, totalFindings: result.total, findingsTruncated: result.truncated || offset > 0, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }), nextStep: 'Use offset with maxFindings to continue, or explain_sku for per-SKU detail. Keep snapshot:name@id fixed across follow-ups.' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.tool(
    'explain_sku',
    'Show one SKU across all sources: raw values, quantities, tracking state, and the findings that mention it.',
    {
      sku: z.string().describe('The SKU to explain'),
      sources: z.array(z.string()).min(1).describe(`Sources to search — each is a ${SOURCE_DESC}`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (optional; config can also tune diagnostic rules)'),
      columnMapping: mappingSchema,
      ...diagnoseSchema,
      maxRecords: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap records returned per source (default 100)'),
      maxFindings: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap findings returned (default 100)'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe(PAGE_DESC),
    },
    async ({ sku, sources, configPath, columnMapping, driftAbs, driftPct, maxRecords, maxFindings, offset = 0 }) => {
      const explanation = await explainSku(sku, sources.map(parseSourceArg), { configPath, columnMapping: mappedColumns(columnMapping), diagnose: diagnoseArgs(driftAbs, driftPct) });
      const recordsCap = pageSize(maxRecords);
      const findingsPage = page(explanation.findings, offset, pageSize(maxFindings));
      const perSource = explanation.perSource.map((source) => {
        const records = page(source.records, offset, recordsCap);
        return { ...source, records: records.items, totalRecords: records.total, recordsTruncated: records.truncated, ...(records.nextOffset === undefined ? {} : { nextRecordsOffset: records.nextOffset }) };
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...explanation, perSource, findings: findingsPage.items, totalFindings: findingsPage.total, findingsTruncated: findingsPage.truncated, ...(findingsPage.nextOffset === undefined ? {} : { nextFindingsOffset: findingsPage.nextOffset }) }, null, 2) }] };
    },
  );

  server.tool(
    'inventory_health',
    'Lightweight sync-health summary for one or more sources: health score, drift distribution, finding counts by severity.',
    {
      sources: z.array(z.string()).min(1).describe(`Sources — each is a ${SOURCE_DESC}`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (optional; config can also tune diagnostic rules)'),
      columnMapping: mappingSchema,
      ...diagnoseSchema,
      maxWarnings: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap warnings returned (default 100)'),
    },
    async ({ sources, configPath, columnMapping, driftAbs, driftPct, maxWarnings }) => {
      const health = await inventoryHealth(sources.map(parseSourceArg), { configPath, columnMapping: mappedColumns(columnMapping), diagnose: diagnoseArgs(driftAbs, driftPct) });
      const warnings = [...new Set((health as { warnings?: string[] }).warnings ?? [])];
      const warningPage = page(warnings, 0, pageSize(maxWarnings));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...health, ...(warnings.length > 0 ? { warnings: warningPage.items, totalWarnings: warningPage.total, warningsTruncated: warningPage.truncated, ...(warningPage.nextOffset === undefined ? {} : { nextWarningsOffset: warningPage.nextOffset }) } : {}) }, null, 2) }] };
    },
  );

  server.tool(
    'sku_history',
    'Trace one SKU across the saved snapshots of a source: per-snapshot quantity series, expanded per location. quantity null means unknown/unreported (a blank CSV cell or unavailable API quantity), never zero. Missing snapshot points are not synthetic zeros. found=false means no matching records in the loaded window; it does not prove the SKU never existed.',
    {
      sku: z.string().describe('The SKU to trace (matched canonically: case/width-insensitive)'),
      snapshotName: z.string().describe('Snapshot group name (the name used with snapshot save)'),
      maxSnapshots: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe('Only load the newest N snapshots (default: all)'),
      maxItems: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap snapshot points returned (default 100)'),
      maxWarnings: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap warnings returned (default 100)'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe(PAGE_DESC),
    },
    async ({ sku, snapshotName, maxSnapshots, maxItems, maxWarnings, offset = 0 }) => {
      const history = await skuHistory(sku, snapshotName, maxSnapshots === undefined ? {} : { maxSnapshots });
      const points = page(history.points, offset, pageSize(maxItems));
      const warnings = page([...new Set(history.warnings)], 0, pageSize(maxWarnings));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...history, points: points.items, totalPoints: points.total, pointsTruncated: points.truncated, ...(points.nextOffset === undefined ? {} : { nextOffset: points.nextOffset }), warnings: warnings.items, totalWarnings: warnings.total, warningsTruncated: warnings.truncated, note: 'Keep the same snapshot:name@id reference for fixed follow-up questions.' }, null, 2) }] };
    },
  );

  server.tool(
    'snapshot_check',
    'Time-series diagnosis over a saved snapshot window: flags observed zero, disappearance or abrupt quantity drops with evidence, conditional risk, assumptions and verification. Does not establish a sync failure or physical stock loss. Needs ≥3 loaded snapshots; maxSnapshots=1 or 2 returns no time-series findings.',
    {
      snapshotName: z.string().describe('Snapshot group name (the name used with snapshot save)'),
      maxSnapshots: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe('Only load the newest N snapshots (default: all)'),
      maxItems: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap snapshots returned (default 100)'),
      maxFindings: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap findings returned (default 100)'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe(PAGE_DESC),
    },
    async ({ snapshotName, maxSnapshots, maxItems, maxFindings, offset = 0 }) => {
      const result = await runSnapshotCheck(snapshotName, maxSnapshots === undefined ? {} : { maxSnapshots });
      const snapshots = page(result.snapshots, offset, pageSize(maxItems));
      const findings = page(result.findings, offset, pageSize(maxFindings));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, snapshots: snapshots.items, findings: findings.items, snapshotsTruncated: snapshots.truncated, totalFindings: findings.total, findingsTruncated: findings.truncated, ...(snapshots.nextOffset === undefined ? {} : { nextSnapshotsOffset: snapshots.nextOffset }), ...(findings.nextOffset === undefined ? {} : { nextFindingsOffset: findings.nextOffset }), note: 'Keep the same snapshot:name@id reference for fixed follow-up questions.' }, null, 2) }] };
    },
  );

  server.tool(
    'fix_export',
    'Build an audit review proposal for sourceB using sourceA as a human-selected baseline, not verified truth. Returns non-importable review CSV, proposals including blocked reasons, raw evidence and verification steps. Proposals, rows and evidence use the same bounded page; CSV is omitted on partial pages. No file or inventory is written; never import the CSV as a repair file. Keep snapshot:name@id references fixed across follow-up questions.',
    {
      sourceA: z.string().describe(`${SOURCE_DESC} — human-selected comparison baseline, not verified truth`),
      sourceB: z.string().describe(`${SOURCE_DESC} — target considered for review, never automatically changed`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (optional; config can also tune diagnostic rules)'),
      columnMapping: mappingSchema,
      ...diagnoseSchema,
      maxItems: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Cap proposals, rows and evidence to one aligned page (default 100)'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe(PAGE_DESC),
    },
    async ({ sourceA, sourceB, configPath, columnMapping, driftAbs, driftPct, maxItems, offset = 0 }) => {
      const { report, sources } = await runDiff([parseSourceArg(sourceA), parseSourceArg(sourceB)], { configPath, columnMapping: mappedColumns(columnMapping), diagnose: diagnoseArgs(driftAbs, driftPct) });
      const records = sources.flatMap((s) => s.records);
      const fix = buildFixExport(report, records);
      const proposalsPage = page(fix.proposals, offset, pageSize(maxItems));
      const proposalKeys = new Set(proposalsPage.items.map((p) => JSON.stringify([p.sku, p.location])));
      const rows = fix.rows.filter((row) => proposalKeys.has(JSON.stringify([row.sku, row.location])));
      const partial = proposalsPage.truncated || offset > 0;
      const { csv, ...metadata } = fix;
      const payload = {
        ...metadata,
        proposals: proposalsPage.items,
        rows,
        ...(partial ? { csvOmitted: true, csvOmittedReason: 'CSV omitted because this is a partial proposal page; it would include proposals outside this response.' } : { csv }),
        direction: `review "${fix.targetSource}" (sourceB) against "${fix.truthSource}" (sourceA, human-selected baseline; not verified truth)`,
        fixRows: rows.length,
        totalRows: fix.rows.length,
        totalItems: proposalsPage.total,
        itemsTruncated: partial,
        ...(proposalsPage.nextOffset === undefined ? {} : { nextOffset: proposalsPage.nextOffset }),
        evidence: proposalsPage.items.map((p) => ({ sku: p.sku, location: p.location, baseline: p.truthEvidence, target: p.targetEvidence })),
        risk: 'A quantity difference does not establish physical stock, an accepted oversell, or which source is correct. Applying an unverified proposal can corrupt inventory.',
        assumptions: [fix.basis],
        verification: [
          'Confirm the baseline and target represent the same stock pool, quantity state, time and location.',
          'Check original source records, reservations, orders, transfers and a physical count before choosing a quantity.',
          'Resolve every blocked reason. Use a platform-specific workflow only after human approval; this CSV is not an import file.',
        ],
        note: 'Review proposal only. reviewRequired=true; importable=false. No inventory or files were written.',
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('inventory-doctor MCP server running on stdio');
}

// Direct execution: `tsx src/mcp.ts`. When launched via the CLI (`inventory-doctor mcp`),
// cli.ts calls startMcpServer() itself.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await startMcpServer();
}
