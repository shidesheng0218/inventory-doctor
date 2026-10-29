import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runDiff, runSnapshotCheck, loadSource, parseSourceArg, type LoadOptions, type SourceInput } from './run.js';
import { saveSnapshot, listSnapshotStubs, pruneSnapshots, planPruneSnapshots } from './snapshots.js';
import { skuHistory } from './history.js';
import { sendWebhook } from './notify.js';
import { loadConfigIfExists } from './config.js';
import type { ColumnMapping } from './adapters/csv/generic.js';
import { renderTerminal } from './report/terminal.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { renderHtml } from './report/html.js';
import { buildFixExport } from './report/fix-export.js';

// stdout discipline: all CLI output goes through process.stdout.write, so the
// MCP stdio transport can never be polluted by a stray print.

type OutputFormat = 'terminal' | 'json' | 'markdown' | 'html';

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

function integerOption(value: string, flag: string, minimum = 1): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error(`${flag} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command();

program
  .name('inventory-doctor')
  .description('Multi-source inventory sync diagnostics — find the SKUs you are overselling without knowing it.')
  .version('0.4.0');

program
  .command('demo')
  .description('Run bundled synthetic examples without credentials or a checkout.')
  .option('--format <format>', 'terminal | json | markdown | html', 'terminal')
  .action(async (opts: { format: string }) => {
    try {
      if (!['terminal', 'json', 'markdown', 'html'].includes(opts.format)) throw new Error('Unknown output format');
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const { report } = await runDiff([
        { kind: 'csv', path: resolve(root, 'fixtures/shopify-store-a.csv') },
        { kind: 'csv', path: resolve(root, 'fixtures/shopify-store-b.csv') },
      ], { configPath: resolve(root, 'fixtures/demo-config.json') });
      process.stderr.write('Synthetic demonstration data; findings are examples, not verified incidents.\n');
      process.stdout.write(opts.format === 'json' ? renderJson(report) : opts.format === 'html' ? renderHtml(report) : opts.format === 'markdown' ? renderMarkdown(report) : renderTerminal(report));
      // A demonstration succeeds even when its deliberately seeded findings are critical.
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

program
  .command('diff')
  .description('Compare inventory across two sources (CSV files and/or configured Shopify stores).')
  .argument('[fileA]', 'first CSV file')
  .argument('[fileB]', 'second CSV file')
  .option('--store <name>', 'configured Shopify store (use twice for store-vs-store)', collect, [])
  .option('--woo <name>', 'configured WooCommerce store (mix with --store/--csv)', collect, [])
  .option('--csv <path>', 'CSV file (mix with --store)', collect, [])
  .option('--config <path>', 'path to inventory-doctor.json')
  .option('--format <format>', 'output format: terminal | json | markdown | html', 'terminal')
  .option('--map <field=header>', 'column mapping for unrecognized CSV files', collect, [])
  .option('--drift-abs <n>', 'absolute quantity drift threshold', (v) => {
    if (!/^\d+(?:\.\d+)?$/.test(v) || !Number.isFinite(Number(v))) throw new Error('--drift-abs must be a finite non-negative number');
    return Number(v);
  })
  .option('--drift-pct <n>', 'percentage quantity drift threshold (0-1)', (v) => {
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v)) throw new Error('--drift-pct must be a number between 0 and 1');
    return Number(v);
  })
  .option('--baseline <ref>', 'compare one source against a saved snapshot ("<name>", "<name>@<id>", or a .jsonl path)')
  .option('--fix-export <path>', 'write an available-quantity review proposal (NOT a Shopify import file)')
  .option('--force', 'allow --fix-export to overwrite an existing file')
  .action(async (fileA: string | undefined, fileB: string | undefined, opts) => {
    try {
      const inputs: SourceInput[] = [];
      for (const path of [fileA, fileB, ...(opts.csv as string[])]) {
        if (path) inputs.push(parseSourceArg(path));
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
        for (const warning of s.warnings ?? []) process.stderr.write(`warning: ${warning}\n`);
      }

      const format = opts.format as OutputFormat;
      const output =
        format === 'json' ? renderJson(report) : format === 'markdown' ? renderMarkdown(report) + '\n' : format === 'html' ? renderHtml(report) + '\n' : renderTerminal(report);
      process.stdout.write(output);

      if (typeof opts.fixExport === 'string') {
        const fix = buildFixExport(report, sources.flatMap((s) => s.records));
        process.stderr.write(`review direction: compare "${fix.targetSource}" against "${fix.truthSource}" (user-selected baseline, not verified truth)\n`);
        process.stderr.write(`warning: ${fix.basis}\n`);
        process.stderr.write(`review proposals: ${fix.rows.length} review-required, ${fix.proposals.filter((p) => p.status === 'blocked').length} blocked; NOT a Shopify import file\n`);
        if (!fix.csv) {
          process.stderr.write('no review proposals — no file written\n');
        } else {
          if (existsSync(opts.fixExport) && !opts.force) {
            throw new Error(`${opts.fixExport} already exists — refusing to overwrite. Pass --force to replace it.`);
          }
          await writeFile(opts.fixExport, fix.csv, { encoding: 'utf8', flag: opts.force ? 'w' : 'wx' });
          process.stderr.write(`wrote review proposal to ${opts.fixExport} — NOT a Shopify import file. Verify quantities, inventory states and locations against source records and a physical count before making changes.\n`);
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
    try {
      const infos = await listSnapshotStubs(name);
      if (infos.length === 0) {
        process.stdout.write(`no snapshots for "${name}"\n`);
        return;
      }
      for (const i of infos) {
        process.stdout.write(`${name}@${i.id}  ${i.savedAt}  ${i.path}\n`);
      }
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

snapshot
  .command('prune')
  .description('Preview retention; pass --yes to delete old snapshots.')
  .argument('<name>', 'snapshot group name')
  .option('--keep <n>', 'newest snapshots to retain (integer >=3)', '30')
  .option('--dry-run', 'preview only; never delete')
  .option('--yes', 'approve deletion after printing the plan')
  .action(async (name: string, opts: { keep: string; dryRun?: boolean; yes?: boolean }) => {
    try {
      const keep = integerOption(opts.keep, '--keep', 3);
      const plan = await planPruneSnapshots(name, keep);
      for (const stub of plan.toRemove) process.stdout.write(`candidate: ${stub.id}  ${stub.path}\n`);
      if (opts.dryRun && opts.yes) throw new Error('--dry-run and --yes are mutually exclusive');
      if (opts.dryRun || !opts.yes) {
        process.stdout.write(`preview "${name}": keep ${plan.kept.length}, would remove ${plan.toRemove.length}; pass --yes to delete\n`);
        return;
      }
      const result = await pruneSnapshots(name, keep);
      process.stdout.write(`pruned "${name}": kept ${result.kept}, removed ${result.removed}\n`);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

snapshot
  .command('check')
  .description('Time-series check across snapshots of a source: catch SKUs silently zeroed between snapshots (needs ≥3 snapshots).')
  .argument('<name>', 'snapshot group name')
  .option('--window <n>', 'only load the newest N snapshots (keeps memory flat as history grows)')
  .option('--webhook <url>', 'POST a JSON alert here when critical findings exist (overrides notify.webhookUrl in config)')
  .action(async (name: string, opts: { window?: string; webhook?: string }) => {
    try {
      // exactOptionalPropertyTypes: simply omit the option when no window was asked for.
      const checkOptions = opts.window === undefined ? {} : { maxSnapshots: integerOption(opts.window, '--window') };
      const result = await runSnapshotCheck(name, checkOptions);
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
      const scope = result.windowed
        ? `${result.snapshots.length} of ${result.totalSnapshots} snapshots (windowed)`
        : `${result.snapshots.length} snapshots`;
      process.stdout.write(`snapshot history for "${name}": ${scope}\n`);
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
      const criticalFindings = result.findings.filter((f) => f.severity === 'critical');
      if (criticalFindings.length > 0) {
        process.exitCode = 1;
        // Critical-alert wiring sits behind a blanket catch: a webhook or
        // config failure must never override the critical exit code above.
        // Only criticals alert — warning-only runs stay silent (alert fatigue).
        try {
          const webhookUrl = opts.webhook ?? (await loadConfigIfExists())?.notify?.webhookUrl;
          if (webhookUrl !== undefined) {
            await sendWebhook(webhookUrl, {
              name,
              critical: criticalFindings.length,
              warning: result.findings.length - criticalFindings.length,
              findings: result.findings.map((f) => ({ severity: f.severity, message: f.message })),
            });
            process.stderr.write(`webhook alert sent (${criticalFindings.length} critical findings)\n`);
          }
        } catch (err) {
          process.stderr.write(`warning: webhook alert failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    }
  });

snapshot
  .command('history')
  .description('Trace one SKU across the snapshots of a source: quantity at each snapshot. (blank) means a blank cell — distinct from 0.')
  .argument('<name>', 'snapshot group name')
  .argument('<sku>', 'SKU to trace (matched canonically: case/width-insensitive)')
  .option('--window <n>', 'only load the newest N snapshots (keeps memory flat as history grows)')
  .action(async (name: string, sku: string, opts: { window?: string }) => {
    try {
      // exactOptionalPropertyTypes: simply omit the option when no window was asked for.
      const history = await skuHistory(sku, name, opts.window === undefined ? {} : { maxSnapshots: integerOption(opts.window, '--window') });
      for (const warning of history.warnings) process.stderr.write(`warning: ${warning}\n`);
      if (!history.found) {
        process.stdout.write(`no records for SKU "${sku}" in snapshot history "${name}"\n`);
        return;
      }
      process.stdout.write(`history for "${history.sku}" (canonical: ${history.canonical}) in "${name}":\n`);
      for (const p of history.points) {
        const qty = p.quantity === null ? '(blank)' : String(p.quantity);
        const loc = p.location === null ? '' : ` @ ${p.location}`;
        process.stdout.write(`  ${p.snapshotId}  ${qty}${loc}\n`);
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
