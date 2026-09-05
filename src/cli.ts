import { Command } from 'commander';
import { runDiff, type LoadOptions, type SourceInput } from './run.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { renderTerminal } from './report/terminal.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';

// stdout discipline: all CLI output goes through process.stdout.write, so the
// MCP stdio transport can never be polluted by a stray print.

type OutputFormat = 'terminal' | 'json' | 'markdown';

function parseMapping(values: string[] | undefined): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const pair of values ?? []) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new Error(`Invalid --map entry "${pair}", expected field=Header (field: sku, quantity, barcode, title, location).`);
    }
    const field = pair.slice(0, eq) as keyof ColumnMapping;
    const header = pair.slice(eq + 1);
    if (!['sku', 'quantity', 'barcode', 'title', 'location'].includes(field)) {
      throw new Error(`Unknown --map field "${field}". Allowed: sku, quantity, barcode, title, location.`);
    }
    mapping[field] = header;
  }
  return mapping;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command();

program
  .name('inventory-doctor')
  .description('Multi-source inventory sync diagnostics — find the SKUs you are overselling without knowing it.')
  .version('0.1.0');

program
  .command('diff')
  .description('Compare inventory across two sources (CSV files and/or configured Shopify stores).')
  .argument('[fileA]', 'first CSV file')
  .argument('[fileB]', 'second CSV file')
  .option('--store <name>', 'configured Shopify store (use twice for store-vs-store)', collect, [])
  .option('--csv <path>', 'CSV file (mix with --store)', collect, [])
  .option('--config <path>', 'path to inventory-doctor.json')
  .option('--format <format>', 'output format: terminal | json | markdown', 'terminal')
  .option('--map <field=header>', 'column mapping for unrecognized CSV files', collect, [])
  .option('--drift-abs <n>', 'absolute quantity drift threshold', (v) => Number(v))
  .option('--drift-pct <n>', 'percentage quantity drift threshold (0-1)', (v) => Number(v))
  .action(async (fileA: string | undefined, fileB: string | undefined, opts) => {
    try {
      const inputs: SourceInput[] = [];
      for (const path of [fileA, fileB, ...(opts.csv as string[])]) {
        if (path) inputs.push({ kind: 'csv', path });
      }
      for (const name of opts.store as string[]) {
        inputs.push({ kind: 'store', name });
      }
      if (inputs.length !== 2) {
        process.stderr.write('error: diff needs exactly two sources, e.g.\n');
        process.stderr.write('  inventory-doctor diff a.csv b.csv\n');
        process.stderr.write('  inventory-doctor diff --store store-a --store store-b\n');
        process.stderr.write('  inventory-doctor diff --store store-a --csv b.csv\n');
        process.exitCode = 2;
        return;
      }

      const loadOptions: LoadOptions = {
        configPath: opts.config as string | undefined,
        columnMapping: parseMapping(opts.map as string[] | undefined),
      };
      const diagnoseOptions: { driftAbsThreshold?: number; driftPctThreshold?: number } = {};
      if (typeof opts.driftAbs === 'number') diagnoseOptions.driftAbsThreshold = opts.driftAbs;
      if (typeof opts.driftPct === 'number') diagnoseOptions.driftPctThreshold = opts.driftPct;

      const { report, sources } = await runDiff([inputs[0] as SourceInput, inputs[1] as SourceInput], {
        ...loadOptions,
        diagnose: diagnoseOptions,
      });

      for (const s of sources) {
        process.stderr.write(`loaded ${s.name}: ${s.records.length} records (${s.detail})\n`);
      }

      const format = opts.format as OutputFormat;
      const output =
        format === 'json' ? renderJson(report) : format === 'markdown' ? renderMarkdown(report) + '\n' : renderTerminal(report);
      process.stdout.write(output);

      // Non-zero exit when critical findings exist — usable in CI/scripts.
      if (report.findings.some((f) => f.severity === 'critical')) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

program
  .command('mcp')
  .description('Start the MCP server on stdio (for Claude Code / other agents).')
  .action(async () => {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
  });

await program.parseAsync(process.argv);
