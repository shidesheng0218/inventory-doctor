import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { explainSku, inventoryHealth, parseSourceArg, runDiff, runSnapshotCheck } from './run.js';
import { skuHistory } from './history.js';
import { buildFixExport } from './report/fix-export.js';

export { parseSourceArg };

// MCP entry point. stdout is the JSON-RPC channel: NOTHING may write to it
// except the SDK transport. All logging goes to console.error (stderr).
// Every log line in this file and its imports must honor that.

// A source argument is a CSV file path, "store:<name>" (resolved through the
// config file + env-referenced credentials), or "snapshot:<name>[@<id>]".
// Parsing lives in run.ts so the CLI and MCP share one definition.
const SOURCE_DESC = 'CSV file path, "store:<name>" for a configured Shopify store, "woo:<name>" for a configured WooCommerce store, or "snapshot:<name>[@<id>]" for a saved snapshot';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'inventory-doctor', version: '0.4.0' });

  server.tool(
    'diff_inventory',
    'Compare inventory across two sources (CSV files and/or configured Shopify stores) and report sync problems (SKU mismatches, oversell risk, oversold stock, blank-vs-zero cells, barcode conflicts, drift). Findings are capped (maxFindings) to keep the payload small; use explain_sku for per-SKU follow-ups.',
    {
      sourceA: z.string().describe(SOURCE_DESC),
      sourceB: z.string().describe(SOURCE_DESC),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (only needed for store: sources)'),
      maxFindings: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Cap on findings returned (default 100). On truncation the response carries totalFindings + a next-step hint.'),
    },
    async ({ sourceA, sourceB, configPath, maxFindings }) => {
      const { report } = await runDiff([parseSourceArg(sourceA), parseSourceArg(sourceB)], { configPath });
      const cap = maxFindings ?? 100;
      if (report.findings.length <= cap) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      }
      const payload = {
        ...report,
        findings: report.findings.slice(0, cap),
        totalFindings: report.findings.length,
        findingsTruncated: true,
        nextStep:
          'Findings were truncated to maxFindings. They are sorted by severity, so the most important ones are included. Use explain_sku(sku, sources) for per-SKU detail on anything omitted.',
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.tool(
    'explain_sku',
    'Show one SKU across all sources: raw values, quantities, tracking state, and the findings that mention it.',
    {
      sku: z.string().describe('The SKU to explain'),
      sources: z.array(z.string()).describe(`Sources to search — each is a ${SOURCE_DESC}`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (only needed for store: sources)'),
    },
    async ({ sku, sources, configPath }) => {
      const explanation = await explainSku(sku, sources.map(parseSourceArg), { configPath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(explanation, null, 2) }] };
    },
  );

  server.tool(
    'inventory_health',
    'Lightweight sync-health summary for one or more sources: health score, drift distribution, finding counts by severity.',
    {
      sources: z.array(z.string()).describe(`Sources — each is a ${SOURCE_DESC}`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (only needed for store: sources)'),
    },
    async ({ sources, configPath }) => {
      const health = await inventoryHealth(sources.map(parseSourceArg), { configPath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] };
    },
  );

  server.tool(
    'sku_history',
    'Trace one SKU across the saved snapshots of a source: per-snapshot quantity series, expanded per location. quantity null means a blank cell (not zero), so "went to zero" vs "stopped being reported" stay distinguishable. found=false means the SKU never appears (points is empty).',
    {
      sku: z.string().describe('The SKU to trace (matched canonically: case/width-insensitive)'),
      snapshotName: z.string().describe('Snapshot group name (the name used with snapshot save)'),
      maxSnapshots: z.number().int().min(1).optional().describe('Only load the newest N snapshots (default: all)'),
    },
    async ({ sku, snapshotName, maxSnapshots }) => {
      const history = await skuHistory(sku, snapshotName, maxSnapshots === undefined ? {} : { maxSnapshots });
      return { content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }] };
    },
  );

  server.tool(
    'snapshot_check',
    'Time-series diagnosis over the saved snapshots of one source: catches a SKU that was stocked for days and is suddenly zeroed or missing ("silently zeroed overnight") — the pattern a one-off diff cannot see. Needs ≥3 saved snapshots.',
    {
      snapshotName: z.string().describe('Snapshot group name (the name used with snapshot save)'),
      maxSnapshots: z.number().int().min(1).optional().describe('Only load the newest N snapshots (default: all)'),
    },
    async ({ snapshotName, maxSnapshots }) => {
      const result = await runSnapshotCheck(snapshotName, maxSnapshots === undefined ? {} : { maxSnapshots });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'fix_export',
    'Turn the critical findings of a two-source diff into a Shopify-importable inventory CSV that brings the SECOND source in line with the FIRST (the source of truth). Returns the CSV as text — review it before importing; nothing is written anywhere. direction reminds you which side is the source of truth.',
    {
      sourceA: z.string().describe(`${SOURCE_DESC} — this is the SOURCE OF TRUTH the other side is aligned to`),
      sourceB: z.string().describe(`${SOURCE_DESC} — this side receives the fix`),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (only needed for store: sources)'),
    },
    async ({ sourceA, sourceB, configPath }) => {
      const { report, sources } = await runDiff([parseSourceArg(sourceA), parseSourceArg(sourceB)], { configPath });
      const records = sources.flatMap((s) => s.records);
      const fix = buildFixExport(report, records);
      const payload = {
        direction: `align "${fix.targetSource}" (sourceB) to "${report.sources[0]}" (sourceA, the source of truth)`,
        fixRows: fix.rows.length,
        note:
          fix.rows.length === 0
            ? 'No importable fixes — critical findings either have no safe write or affect the truth side.'
            : 'Review this CSV, then import it into the target source. Verify first: diff sourceA against this CSV.',
        csv: fix.csv,
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
