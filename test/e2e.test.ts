import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runDiff } from '../src/run.js';
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
