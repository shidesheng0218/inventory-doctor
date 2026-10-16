import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { runDiff } from '../src/run.js';
import { buildFixExport } from '../src/report/fix-export.js';
import { diagnose } from '../src/core/diagnose.js';
import type { InventoryRecord } from '../src/core/types.js';

const A = 'fixtures/shopify-store-a.csv';
const B = 'fixtures/shopify-store-b.csv';
function rec(source: string, quantity: number | null, overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  return { source, sku: 'SKU-1', location: null, quantity, quantityRaw: quantity === null ? '' : String(quantity),
    barcode: null, title: null, tracked: true, cellIsBlank: quantity === null, meta: {}, ...overrides };
}
function review(records: InventoryRecord[]) {
  return buildFixExport(diagnose(records), records);
}

describe('review proposal export', () => {
  it('keeps CLI aliases but exports explicitly non-importable proposals and blocked evidence', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    const fix = buildFixExport(report, sources.flatMap((s) => s.records));
    expect(fix).toMatchObject({ targetSource: 'shopify-store-b', truthSource: 'shopify-store-a', reviewRequired: true, importable: false });
    expect(fix.rows.find((r) => r.sku === 'OVER-1')).toMatchObject({ quantity: 0, proposedAvailable: 0, reason: 'oversell-risk' });
    expect(fix.rows.find((r) => r.sku === 'DRIFT-1')).toMatchObject({ quantity: 100, targetQuantity: 92 });
    expect(fix.rows.some((r) => r.sku === 'BLANK-1' || r.sku === 'DUP-100')).toBe(false);
    expect(fix.proposals.find((r) => r.sku === 'BLANK-1')).toMatchObject({ status: 'blocked', proposedAvailable: null });
    expect(fix.basis).toContain('not objective truth');
    const parsed = Papa.parse<Record<string, string>>(fix.csv, { header: true, skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.meta.fields).toContain('Proposed available quantity (review only)');
    expect(parsed.meta.fields).toContain('Review status');
    expect(parsed.meta.fields?.some((h) => /on hand|available \(not editable\)|^SKU$|^Location$/i.test(h))).toBe(false);
    expect(parsed.data.every((r) => r['Importable'] === 'false' && r['Document type']?.includes('NOT an importable'))).toBe(true);
    expect(parsed.data.find((r) => r['Compared SKU'] === 'OVER-1')?.['Target observed quantity']).toBe('8');
  });

  it('csv output matches fixtures/expected-fix.csv', async () => {
    const { report, sources } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }]);
    expect(buildFixExport(report, sources.flatMap((s) => s.records)).csv).toBe(await readFile('fixtures/expected-fix.csv', 'utf8'));
  });

  it('uses real diagnose default unknown-basis warning findings without a severity gate', () => {
    const records = [rec('a', 100), rec('b', 92)];
    const report = diagnose(records);
    expect(report.findings.find((f) => f.rule === 'oversell-risk')?.severity).toBe('warning');
    const fix = buildFixExport(report, records);
    expect(fix.rows[0]).toMatchObject({ quantity: 100, truthQuantity: 100, targetQuantity: 92, status: 'review-required' });
    expect(fix.rows[0]?.basis).toContain('unknown');
    expect(fix.importable).toBe(false);
    report.findings = report.findings.map((f) => ({ ...f, severity: 'info' }));
    expect(buildFixExport(report, records).rows[0]?.quantity).toBe(100);
  });

  it('follows report source order in either direction and preserves raw target SKU', () => {
    const records = [rec('a', 0), rec('b', 8, { sku: ' sku-1 ' })];
    const report = diagnose(records);
    expect(buildFixExport(report, records).rows[0]).toMatchObject({ quantity: 0, targetSku: ' sku-1 ' });
    report.sources = ['b', 'a'];
    const reverse = buildFixExport(report, records);
    expect(reverse.targetSource).toBe('a');
    expect(reverse.rows[0]).toMatchObject({ quantity: 8, targetSku: 'SKU-1', truthQuantity: 8, targetQuantity: 0 });
  });

  it.each(['a', 'b'])('blocks duplicate canonical SKU/location records in %s, even with equal quantities', (source) => {
    const records = [rec('a', 0), rec('b', 8), rec(source, source === 'a' ? 0 : 8, { sku: ' sku-1 ' })];
    const fix = review(records);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals[0]?.blockedReasons).toContain(source === 'a' ? 'non-unique-baseline-match' : 'non-unique-target-match');
    expect(fix.proposals[0]?.proposedAvailable).toBeNull();
    expect(source === 'a' ? fix.proposals[0]?.truthEvidence : fix.proposals[0]?.targetEvidence).toHaveLength(2);
  });

  it('allows independent unique location matches without summing warehouses', () => {
    const records = [rec('a', 0, { location: ' East ' }), rec('a', 100, { location: 'West' }),
      rec('b', 8, { location: 'East' }), rec('b', 92, { location: 'West' })];
    const fix = review(records);
    expect(fix.rows.map((r) => [r.location, r.quantity])).toEqual([['East', 0], ['West', 100]]);
  });

  it.each([true, false])('blocks cross-location aggregates in either direction (reverse=%s)', (reverse) => {
    const records = [rec('a', 0), rec('b', 4, { location: 'East' }), rec('b', 4, { location: 'West' })];
    if (reverse) records.reverse();
    const fix = review(records);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals[0]?.blockedReasons).toContain('location-aggregate-or-mismatch');
    expect(fix.proposals[0]?.proposedAvailable).toBeNull();
  });

  it('blocks a single named warehouse compared to a source with no location', () => {
    const fix = review([rec('a', 0), rec('b', 8, { location: 'East' })]);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals[0]?.blockedReasons).toContain('location-aggregate-or-mismatch');
  });

  it('does not merge distinct SKU/location keys by concatenation', () => {
    const records = [rec('a', 0, { sku: 'AB', location: 'C' }), rec('a', 0, { sku: 'A', location: 'BC' }),
      rec('b', 8, { sku: 'AB', location: 'C' }), rec('b', 8, { sku: 'A', location: 'BC' })];
    expect(review(records).rows).toHaveLength(2);
  });

  it('blocks missing target/baseline identities and empty identifiers', () => {
    const fix = review([rec('a', 8), rec('b', 0, { sku: 'OTHER' }), rec('b', 4, { sku: null })]);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals.some((p) => p.blockedReasons.includes('missing-target-match'))).toBe(true);
    expect(fix.proposals.some((p) => p.blockedReasons.includes('missing-baseline-match'))).toBe(true);
    expect(fix.proposals.some((p) => p.blockedReasons.includes('missing-sku'))).toBe(true);
  });

  it('blocks negative proposed available quantities', () => {
    const fix = review([rec('a', -2), rec('b', 8)]);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals[0]?.blockedReasons).toContain('negative-proposal');
  });

  it.each(['a', 'b'])('blocks null quantity on %s rather than inventing zero', (source) => {
    const fix = review([rec('a', source === 'a' ? null : 8), rec('b', source === 'b' ? null : 8)]);
    expect(fix.rows).toEqual([]);
    expect(fix.proposals[0]?.blockedReasons).toContain(source === 'a' ? 'unknown-baseline-quantity' : 'unknown-target-quantity');
    expect(fix.proposals[0]?.proposedAvailable).toBeNull();
  });

  it('only considers the first two sources and ignores unrelated policy findings', () => {
    const records = [rec('a', 0), rec('b', 0), rec('c', 8)];
    expect(review(records).rows).toEqual([]);
    expect(review(records).proposals).toEqual([]);
  });

  it('returns flags and empty output when there are no relevant findings or no target', () => {
    for (const records of [[rec('a', 8), rec('b', 8)], [rec('a', 8)], []]) {
      expect(review(records)).toMatchObject({ rows: [], proposals: [], csv: '', reviewRequired: true, importable: false });
    }
  });
});
