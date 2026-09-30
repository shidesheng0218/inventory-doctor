import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runDiff } from '../src/run.js';
import { buildFixExport } from '../src/report/fix-export.js';
import { loadCsv } from '../src/adapters/csv/index.js';

const A = 'fixtures/shopify-store-a.csv';
const B = 'fixtures/shopify-store-b.csv';

describe('fix export', () => {
  it('turns critical findings into rows that bring B in line with A', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const fix = buildFixExport(report, sources.flatMap((s) => s.records));

    expect(fix.targetSource).toBe('shopify-store-b');
    // OVER-1: A has 0 (truth) → write 0 to B. BLANK-1: the blank is in A, the
    // truth side → nothing safe to write, skipped. DRIFT-1 is only a warning
    // (diff 8 < severe threshold) → warnings are not exported as fixes.
    const over = fix.rows.find((r) => r.sku === 'OVER-1');
    expect(over).toMatchObject({ quantity: 0, reason: 'oversell-risk' });
    expect(fix.rows.some((r) => r.sku === 'BLANK-1')).toBe(false);
    expect(fix.rows.some((r) => r.sku === 'DRIFT-1')).toBe(false);
  });

  it('csv output matches fixtures/expected-fix.csv (living document)', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const fix = buildFixExport(report, sources.flatMap((s) => s.records));
    const expected = await readFile('fixtures/expected-fix.csv', 'utf8');
    expect(fix.csv).toBe(expected);
  });

  it('the fix file round-trips through our own CSV adapter', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const fix = buildFixExport(report, sources.flatMap((s) => s.records));
    const parsed = loadCsv(fix.csv, 'fix');
    expect(parsed.records.length).toBe(fix.rows.length);
    expect(parsed.records.every((r) => r.quantity !== null)).toBe(true);
  });

  it('writes nothing when there are no fixable critical findings', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: A }]);
    const fix = buildFixExport(report, sources.flatMap((s) => s.records));
    expect(fix.rows).toEqual([]);
    expect(fix.csv).toBe('');
  });
});
