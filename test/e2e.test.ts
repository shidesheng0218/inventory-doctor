import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiff, runSnapshotCheck } from '../src/run.js';
import { saveSnapshot } from '../src/snapshots.js';
import { loadCsv } from '../src/adapters/csv/index.js';
import { renderMarkdown } from '../src/report/markdown.js';

const A = 'fixtures/shopify-store-a.csv';
const B = 'fixtures/shopify-store-b.csv';

describe('fixtures end-to-end', () => {
  it('hits every planted problem', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const byRule = new Map<string, number>();
    for (const f of report.findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

    // All six rules fire on the fixture pair.
    for (const rule of ['sku-mismatch', 'oversell-risk', 'blank-vs-zero', 'barcode-crosscheck', 'quantity-drift', 'untracked']) {
      expect(byRule.get(rule), `rule ${rule} should fire`).toBeGreaterThan(0);
    }

    const messages = report.findings.map((f) => f.message).join('\n');
    for (const planted of [
      'letter case', // ABC-123 vs abc-123
      'whitespace', // DEF-456 vs "DEF-456 "
      'prefix/suffix', // GHI-789 vs SHOP-GHI-789
      'ORPHAN-A',
      'ORPHAN-B',
      'appears 2 times', // DUP-100 one-to-many
      'out of stock', // OVER-1
      'BLANK quantity cell', // BLANK-1
      'Barcode 9999999', // BC-A vs BC-B
      'continue selling', // CONT-1
      'tracking OFF', // UNTRACKED-1
      'differs by 8', // DRIFT-1
    ]) {
      expect(messages).toContain(planted);
    }

    // The explicit "0" must NOT produce a blank-cell finding.
    const blankFindings = report.findings.filter((f) => f.rule === 'blank-vs-zero');
    expect(blankFindings).toHaveLength(1);
    expect(blankFindings[0]?.sku).toBe('BLANK-1');
  });

  it('markdown output matches fixtures/expected-report.md (living document)', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const expected = await readFile('fixtures/expected-report.md', 'utf8');
    expect(renderMarkdown(report) + '\n').toBe(expected);
  });
});

describe('multi-location fixtures end-to-end (long inventory CSV)', () => {
  const C = 'fixtures/shopify-inventory-c.csv';
  const D = 'fixtures/shopify-inventory-d.csv';

  it('no one-to-many false positives for normal multi-location SKUs', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: C }, { kind: 'csv', path: D }]);
    expect(report.findings.filter((f) => f.message.includes('appears'))).toHaveLength(0);
  });

  it('reports location-level drift and oversell, not hidden by cross-location sums', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: C }, { kind: 'csv', path: D }]);
    const messages = report.findings.map((f) => f.message).join('\n');
    expect(messages).toContain('"MULTI-2" quantity differs by 8 (40%) at location "Warehouse A"');
    expect(messages).toContain('"MULTI-3" is out of stock in shopify-inventory-c (0) at location "Warehouse A"');
    // MULTI-1 and Warehouse B rows agree → no findings mention them.
    expect(messages).not.toContain('MULTI-1');
    expect(messages).not.toContain('Warehouse B');
    expect(report.healthSummary).toEqual({ matched: 5, minorDrift: 0, severeDrift: 2, unmatched: 0, totalCompared: 7 });
  });

  it('markdown output matches fixtures/expected-report-multilocation.md', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: C }, { kind: 'csv', path: D }]);
    const expected = await readFile('fixtures/expected-report-multilocation.md', 'utf8');
    expect(renderMarkdown(report) + '\n').toBe(expected);
  });
});

describe('wide inventory CSV fixtures end-to-end', () => {
  const E = 'fixtures/shopify-inventory-wide-e.csv';
  const F = 'fixtures/shopify-inventory-wide-f.csv';

  it('detects the wide format and treats location headers as locations', async () => {
    const { sources } = await runDiff([{ kind: 'csv', path: E }, { kind: 'csv', path: F }]);
    expect(sources[0]?.detail).toContain('unrecognized headers treated as locations');
    expect(sources[0]?.records).toHaveLength(4);
    expect(sources[0]?.records.map((r) => r.location)).toEqual([
      'Warehouse A',
      'Warehouse B',
      'Warehouse A',
      'Warehouse B',
    ]);
  });

  it('blank wide-table cell produces blank-vs-zero critical at that location', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: E }, { kind: 'csv', path: F }]);
    const blank = report.findings.filter((f) => f.rule === 'blank-vs-zero');
    expect(blank).toHaveLength(1);
    expect(blank[0]?.message).toContain('"WIDE-1"');
    expect(blank[0]?.message).toContain('at location "Warehouse A"');
    // WIDE-2 agrees exactly in both locations → no findings.
    expect(report.findings.map((f) => f.message).join('\n')).not.toContain('WIDE-2');
    expect(report.healthSummary).toEqual({ matched: 3, minorDrift: 0, severeDrift: 1, unmatched: 0, totalCompared: 4 });
  });
});

describe('Amazon-style TSV fixture end-to-end', () => {
  it('parses fixtures/amazon-export.txt via generic probing without any mapping', async () => {
    const { sources } = await runDiff([
      { kind: 'csv', path: 'fixtures/amazon-export.txt' },
      { kind: 'csv', path: 'fixtures/amazon-export.txt' },
    ]);
    const [amazon] = sources;
    expect(amazon?.detail).toContain('unrecognized');
    expect(amazon?.records).toHaveLength(3);
    const tee = amazon?.records.find((r) => r.sku === 'AMZ-TEE-BLK');
    expect(tee).toMatchObject({ quantity: 12, barcode: 'B000TEE001', location: 'FBA' });
    const zero = amazon?.records.find((r) => r.sku === 'AMZ-MUG-WHT');
    expect(zero?.quantity).toBe(0);
    expect(zero?.quantityRaw).toBe('0');
    // Blank quantity cell stays null, never coerced to 0.
    const blank = amazon?.records.find((r) => r.sku === 'AMZ-CAP-NVY');
    expect(blank?.quantity).toBeNull();
    expect(blank?.quantityRaw).toBe('');
  });
});

describe('load failures are loud, never a vacuous "healthy" report', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-load-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a headers-only CSV (0 records) instead of reporting health 100', async () => {
    const empty = join(dir, 'empty.csv');
    await writeFile(empty, 'Handle,Title,SKU,Variant Inventory Qty\n', 'utf8');
    await expect(runDiff([{ kind: 'csv', path: empty }, { kind: 'csv', path: A }])).rejects.toThrow(/0 records/);
  });

  it('rejects a CSV whose SKU column is entirely blank', async () => {
    const blank = join(dir, 'blank-skus.csv');
    await writeFile(blank, 'Handle,Title,SKU,Variant Inventory Qty\nw,Widget,,5\n', 'utf8');
    await expect(runDiff([{ kind: 'csv', path: blank }, { kind: 'csv', path: A }])).rejects.toThrow(/0 records/);
  });

  it('says "CSV file not found" instead of a raw ENOENT', async () => {
    await expect(runDiff([{ kind: 'csv', path: join(dir, 'nope.csv') }, { kind: 'csv', path: A }])).rejects.toThrow(
      /CSV file not found/,
    );
  });
});

describe('CLI: --fix-export never clobbers an existing file', () => {
  const tsx = join('node_modules', '.bin', 'tsx');
  const runCli = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
      execFile(tsx, ['src/cli.ts', ...args], (error, stdout, stderr) => {
        resolvePromise({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr });
      });
    });

  it('refuses to overwrite without --force, overwrites with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-fix-'));
    try {
      const fixPath = join(dir, 'fix.csv');
      const first = await runCli(['diff', A, B, '--fix-export', fixPath]);
      expect(first.code).toBe(1); // critical findings exist
      expect(first.stderr).toContain('fix rows');
      // The fix direction must be explicit: first source = source of truth.
      expect(first.stderr).toContain('fix direction: bring "shopify-store-b" in line with "shopify-store-a"');
      expect(first.stderr).toContain(`verify before importing: inventory-doctor diff ${A} ${fixPath}`);
      expect(first.stderr).toContain('not covered by this fix file');

      const second = await runCli(['diff', A, B, '--fix-export', fixPath]);
      expect(second.code).toBe(2);
      expect(second.stderr).toContain('already exists');
      expect(second.stderr).toContain('--force');

      const third = await runCli(['diff', A, B, '--fix-export', fixPath, '--force']);
      expect(third.code).toBe(1);
      expect(third.stderr).toContain('fix rows');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('snapshot history end-to-end', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-e2e-'));
    process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = dir;
  });
  afterEach(async () => {
    delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
    await rm(dir, { recursive: true, force: true });
  });

  it('diff --baseline: a clean CSV vs its own snapshot is a perfect score', async () => {
    // Fixture A contains planted single-source problems (dup SKU, blank cell)
    // that fire in ANY comparison, so use a small clean catalog here.
    const clean = 'Handle,Title,SKU,Variant Inventory Qty\nw,Widget,W-1,5\nt,Tee,T-1,3\n';
    const records = loadCsv(clean, 'clean-shop').records;
    await saveSnapshot('clean-shop', records, new Date('2026-09-01T08:00:00Z'));

    const { report, sources } = await runDiff([
      { kind: 'csv', path: 'fixtures/clean-shop.csv' },
      { kind: 'snapshot', ref: 'clean-shop' },
    ]);
    expect(sources[1]?.name).toBe('clean-shop@2026-09-01T08-00-00');
    // quantity-drift always emits its health-score info line; nothing above info.
    expect(report.findings.filter((f) => f.severity !== 'info')).toHaveLength(0);
    expect(report.healthScore).toBe(100);
  });

  it('snapshot check catches a silently zeroed SKU across 3 snapshots', async () => {
    const csv = (qty: number) => `Handle,Title,SKU,Variant Inventory Qty\nw,Widget,WIDGET-9,${qty}\n`;
    for (const [i, qty] of [12, 12, 0].entries()) {
      const result = loadCsv(csv(qty), 'shop');
      await saveSnapshot('shop', result.records, new Date(`2026-09-0${i + 1}T08:00:00Z`));
    }
    const check = await runSnapshotCheck('shop');
    expect(check.snapshots).toHaveLength(3);
    const critical = check.findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]?.message).toContain('WIDGET-9');
    expect(critical[0]?.message).toContain('silently zeroed');
  });
});
