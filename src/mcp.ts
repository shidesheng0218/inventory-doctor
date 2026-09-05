import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { explainSku, inventoryHealth, runDiff, type SourceInput } from './run.js';

// MCP entry point. stdout is the JSON-RPC channel: NOTHING may write to it
// except the SDK transport. All logging goes to console.error (stderr).
// Every log line in this file and its imports must honor that.

// A source argument is either a CSV file path or "store:<name>" — the latter
// resolves through the config file + env-referenced credentials.
export function parseSourceArg(value: string): SourceInput {
  if (value.startsWith('store:')) {
    const name = value.slice('store:'.length).trim();
    if (name === '') throw new Error('source "store:" is missing the store name, expected "store:<name>"');
    return { kind: 'store', name };
  }
  return { kind: 'csv', path: value };
}

const SOURCE_DESC = 'CSV file path, or "store:<name>" for a configured Shopify store';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'inventory-doctor', version: '0.1.0' });

  server.tool(
    'diff_inventory',
    'Compare inventory across two sources (CSV files and/or configured Shopify stores) and report sync problems (SKU mismatches, oversell risk, blank-vs-zero cells, barcode conflicts, drift).',
    {
      sourceA: z.string().describe(SOURCE_DESC),
      sourceB: z.string().describe(SOURCE_DESC),
      configPath: z.string().optional().describe('Path to inventory-doctor.json (only needed for store: sources)'),
    },
    async ({ sourceA, sourceB, configPath }) => {
      const { report } = await runDiff([parseSourceArg(sourceA), parseSourceArg(sourceB)], { configPath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
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
