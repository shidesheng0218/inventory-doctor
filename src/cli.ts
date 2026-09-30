import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runDiff, runSnapshotCheck, loadSource, parseSourceArg, type LoadOptions, type SourceInput } from './run.js';
import { saveSnapshot, listSnapshots } from './snapshots.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { renderTerminal } from './report/terminal.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { buildFixExport } from './report/fix-export.js';

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

// Reconstruct the command-line form of a source, for the post-fix verify hint.
function sourceArgFor(input: SourceInput): string {
  switch (input.kind) {
    case 'csv':
      return input.path;
    case 'store':
      return `--store ${input.name}`;
    case 'woo':
      return `--woo ${input.name}`;
    case 'snapshot':
      return `--baseline ${input.ref}`;
  }
}

const program = new Command();

program
  .name('inventory-doctor')
  .description('Multi-source inventory sync diagnostics — find the SKUs you are overselling without knowing it.')
  .version('0.2.1');

program
  .command('diff')
  .description('Compare inventory across two sources (CSV files and/or configured Shopify stores).')
  .argument('[fileA]', 'first CSV file')
  .argument('[fileB]', 'second CSV file')
  .option('--store <name>', 'configured Shopify store (use twice for store-vs-store)', collect, [])
  .option('--woo <name>', 'configured WooCommerce store (mix with --store/--csv)', collect, [])
  .option('--csv <path>', 'CSV file (mix with --store)', collect, [])
  .option('--config <path>', 'path to inventory-doctor.json')
  .option('--format <format>', 'output format: terminal | json | markdown', 'terminal')
  .option('--map <field=header>', 'column mapping for unrecognized CSV files', collect, [])
  .option('--drift-abs <n>', 'absolute quantity drift threshold', (v) => Number(v))
  .option('--drift-pct <n>', 'percentage quantity drift threshold (0-1)', (v) => Number(v))
  .option('--baseline <ref>', 'compare one source against a saved snapshot ("<name>", "<name>@<id>", or a .jsonl path)')
  .option('--fix-export <path>', 'write a Shopify-importable CSV that brings the second source in line with the first')
  .option('--force', 'allow --fix-export to overwrite an existing file')
  .action(async (fileA: string | undefined, fileB: string | undefined, opts) => {
    try {
      const inputs: SourceInput[] = [];
      for (const path of [fileA, fileB, ...(opts.csv as string[])]) {
        if (path) inputs.push({ kind: 'csv', path });
      }
      for (const name of opts.store as string[]) {
        inputs.push({ kind: 'store', name });
      }
      for (const name of opts.woo as string[]) {
        inputs.push({ kind: 'woo', name });
      }
      if (opts.baseline !== undefined) {
        inputs.push({ kind: 'snapshot', ref: opts.baseline as string });
      }
      if (inputs.length !== 2) {
        process.stderr.write('error: diff needs exactly two sources, e.g.\n');
        process.stderr.write('  inventory-doctor diff a.csv b.csv\n');
        process.stderr.write('  inventory-doctor diff --store store-a --store store-b\n');
        process.stderr.write('  inventory-doctor diff --store store-a --csv b.csv\n');
        process.stderr.write('  inventory-doctor diff --store store-a --woo woo-shop  # Shopify vs WooCommerce\n');
        process.stderr.write('  inventory-doctor diff a.csv --baseline store-a        # now vs saved snapshot\n');
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

      if (typeof opts.fixExport === 'string') {
        const fix = buildFixExport(report, sources.flatMap((s) => s.records));
        // The fix direction is a semantic decision the user must see: the
        // FIRST source is the source of truth, and with mixed flags the first
        // source is not necessarily the first flag on the command line
        // (precedence: positional files, --csv, --store, --woo, --baseline).
        const truth = sources[0]?.name ?? '';
        const criticals = report.findings.filter((f) => f.severity === 'critical').length;
        if (fix.rows.length === 0) {
          process.stderr.write('no fixable critical findings — no fix file written\n');
          if (criticals > 0) {
            process.stderr.write(
              `note: ${criticals} critical finding(s) cannot be fixed by an inventory import ` +
                '(e.g. SKUs missing from the target entirely) — resolve those in the source systems.\n',
            );
          }
        } else if (existsSync(opts.fixExport) && !opts.force) {
          // A fix file is meant to be reviewed and imported — clobbering a
          // previous one silently would destroy that audit trail.
          process.stderr.write(
            `error: ${opts.fixExport} already exists — refusing to overwrite. Pass --force to replace it.\n`,
          );
          process.exitCode = 2;
          return;
        } else {
          process.stderr.write(
            `fix direction: bring "${fix.targetSource}" in line with "${truth}" (first source = source of truth)\n`,
          );
          await writeFile(opts.fixExport, fix.csv, 'utf8');
          process.stderr.write(
            `wrote ${fix.rows.length} fix rows to ${opts.fixExport} — review it, then import into ${fix.targetSource}\n`,
          );
          // Close the loop: re-diffing the truth source against the fix file
          // proves the fix would heal the report before anything is imported.
          process.stderr.write(
            `verify before importing: inventory-doctor diff ${sourceArgFor(inputs[0] as SourceInput)} ${opts.fixExport}\n`,
          );
          if (criticals > fix.rows.length) {
            process.stderr.write(
              `note: ${criticals - fix.rows.length} critical finding(s) are not covered by this fix file ` +
                '(an inventory import cannot create missing SKUs or re-map barcodes) — resolve those in the source systems.\n',
            );
          }
        }
      }

      // Non-zero exit when critical findings exist — usable in CI/scripts.
      if (report.findings.some((f) => f.severity === 'critical')) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

const snapshot = program.command('snapshot').description('Save and inspect local inventory snapshots (time-series diagnosis).');

snapshot
  .command('save')
  .description('Save a snapshot of a source (CSV path or store:<name>) for later --baseline / check use.')
  .argument('<source>', 'CSV file path or store:<name>')
  .option('--name <name>', 'snapshot group name (default: file basename or store name)')
  .option('--config <path>', 'path to inventory-doctor.json')
  .option('--map <field=header>', 'column mapping for unrecognized CSV files', collect, [])
  .action(async (sourceArg: string, opts) => {
    try {
      const input = parseSourceArg(sourceArg);
      const loaded = await loadSource(input, {
        configPath: opts.config as string | undefined,
        columnMapping: parseMapping(opts.map as string[] | undefined),
      });
      const name = (opts.name as string | undefined) ?? loaded.name.replace(/\.(csv|tsv|txt)$/i, '');
      const info = await saveSnapshot(name, loaded.records);
      process.stderr.write(`loaded ${loaded.name}: ${loaded.records.length} records (${loaded.detail})\n`);
      process.stdout.write(`saved snapshot ${name}@${info.id} (${info.recordCount} records) → ${info.path}\n`);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

snapshot
  .command('list')
  .description('List saved snapshots for a source name.')
  .argument('<name>', 'snapshot group name')
  .action(async (name: string) => {
    const infos = await listSnapshots(name);
    if (infos.length === 0) {
      process.stdout.write(`no snapshots for "${name}"\n`);
      return;
    }
    for (const i of infos) {
      process.stdout.write(`${name}@${i.id}  ${i.recordCount} records  ${i.path}\n`);
    }
  });

snapshot
  .command('check')
  .description('Time-series check across all snapshots of a source: catch SKUs silently zeroed between snapshots (needs ≥3 snapshots).')
  .argument('<name>', 'snapshot group name')
  .action(async (name: string) => {
    try {
      const result = await runSnapshotCheck(name);
      process.stdout.write(`snapshot history for "${name}": ${result.snapshots.length} snapshots\n`);
      for (const s of result.snapshots) {
        process.stdout.write(`  ${s.id}  ${s.recordCount} records\n`);
      }
      process.stdout.write('\n');
      if (result.snapshots.length < 3) {
        process.stdout.write('Need at least 3 snapshots for time-series detection — keep saving on a schedule (cron/CI).\n');
        return;
      }
      if (result.findings.length === 0) {
        process.stdout.write('No time-series findings. Snapshot history looks stable.\n');
        return;
      }
      for (const f of result.findings) {
        process.stdout.write(`[${f.severity.toUpperCase()}] ${f.message}\n           fix: ${f.suggestion}\n`);
      }
      if (result.findings.some((f) => f.severity === 'critical')) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

program
  .command('auth')
  .description('Run the Shopify OAuth flow for a store (agency / cross-org setups where client credentials get shop_not_permitted).')
  .argument('<domain>', 'shop domain, e.g. client-store.myshopify.com')
  .requiredOption('--client-id <id>', 'app client id (Dev Dashboard app with a loopback redirect URL registered)')
  .requiredOption('--client-secret <secret>', 'app client secret')
  .option('--scopes <list>', 'comma-separated scopes', 'read_inventory,read_products,read_locations')
  .action(async (domain: string, opts) => {
    try {
      const { runOAuthFlow } = await import('./adapters/shopify-api/oauth.js');
      const result = await runOAuthFlow({
        domain,
        clientId: opts.clientId as string,
        clientSecret: opts.clientSecret as string,
        scopes: (opts.scopes as string).split(',').map((s: string) => s.trim()),
      });
      process.stderr.write(`token for ${domain} saved to ${result.tokenFilePath} (scope: ${result.scope})\n`);
      process.stdout.write(`Add to inventory-doctor.json: { "name": "...", "domain": "${domain}", "oauth": true }\n`);
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
