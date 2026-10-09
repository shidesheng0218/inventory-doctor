import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAvailability } from '../../src/core/rules/bundle-availability.js';
import { runDiff } from '../../src/run.js';
import type { BundleDef, DiagnoseOptions } from '../../src/core/types.js';
import { rec } from '../helpers.js';

const OPTS: DiagnoseOptions = { driftAbsThreshold: 5, driftPctThreshold: 0.2 };

// 1 bundle = 1x KIT-A + 2x KIT-B.
const KIT: BundleDef = {
  sku: 'GIFT-KIT',
  components: [
    { sku: 'KIT-A', quantity: 1 },
    { sku: 'KIT-B', quantity: 2 },
  ],
};

describe('bundle-availability', () => {
  it('returns [] when options.bundles is undefined or empty', () => {
    const records = [rec({ source: 'a', sku: 'KIT-A', quantity: 5 }), rec({ source: 'a', sku: 'KIT-B', quantity: 5 })];
    expect(bundleAvailability(records, OPTS)).toEqual([]);
    expect(bundleAvailability(records, { ...OPTS, bundles: [] })).toEqual([]);
  });

  it('computes computedMax = min(floor(qty / required)) and warns on listed-vs-computed drift', () => {
    const records = [
      rec({ source: 'a', sku: 'KIT-A', quantity: 5 }),
      rec({ source: 'a', sku: 'KIT-B', quantity: 5 }),
      rec({ source: 'a', sku: 'GIFT-KIT', quantity: 3 }),
    ];
    const findings = bundleAvailability(records, { ...OPTS, bundles: [KIT] });
    // computedMax = min(floor(5/1), floor(5/2)) = 2; listed 3 vs 2 → drift warning.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.rule).toBe('bundle-availability');
    expect(findings[0]?.sku).toBe('GIFT-KIT');
    expect(findings[0]?.detail['computedMax']).toBe(2);
    expect(findings[0]?.detail['listed']).toBe(3);
    expect(findings[0]?.message).toContain('GIFT-KIT');
  });

  it('flags critical when the bundle is listed sellable but components cannot support even one', () => {
    const records = [
      rec({ source: 'a', sku: 'KIT-A', quantity: 5 }),
      rec({ source: 'a', sku: 'KIT-B', quantity: 0 }),
      rec({ source: 'a', sku: 'GIFT-KIT', quantity: 1 }),
    ];
    const findings = bundleAvailability(records, { ...OPTS, bundles: [KIT] });
    // computedMax = min(5, floor(0/2)) = 0; listed 1 > 0 → critical.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.message).toContain('listed');
  });

  it('warns when a component is missing from the source and excludes it from the min', () => {
    const records = [
      rec({ source: 'a', sku: 'KIT-A', quantity: 10 }),
      rec({ source: 'a', sku: 'GIFT-KIT', quantity: 10 }),
    ];
    const findings = bundleAvailability(records, { ...OPTS, bundles: [KIT] });
    // KIT-B absent in source "a" → warning; not counted as 0, so no critical.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.detail['missing']).toEqual(['KIT-B']);
    expect(findings[0]?.message).toContain('missing');
  });

  it('is silent when the bundle is not listed in a source', () => {
    const records = [rec({ source: 'a', sku: 'KIT-A', quantity: 5 }), rec({ source: 'b', sku: 'KIT-A', quantity: 5 })];
    expect(bundleAvailability(records, { ...OPTS, bundles: [KIT] })).toEqual([]);
  });

  it('evaluates per (source, location); sources without a location dimension use the cross-location sum', () => {
    const records = [
      // Source "store": location dimension — two warehouses.
      rec({ source: 'store', sku: 'KIT-A', location: 'WH-1', quantity: 4 }),
      rec({ source: 'store', sku: 'KIT-B', location: 'WH-1', quantity: 0 }),
      rec({ source: 'store', sku: 'GIFT-KIT', location: 'WH-1', quantity: 2 }),
      rec({ source: 'store', sku: 'KIT-A', location: 'WH-2', quantity: 4 }),
      rec({ source: 'store', sku: 'KIT-B', location: 'WH-2', quantity: 10 }),
      rec({ source: 'store', sku: 'GIFT-KIT', location: 'WH-2', quantity: 2 }),
      // Source "flat": one stray located row gives it a location dimension —
      // location-less rows fall into their own '(no location)' bucket.
      rec({ source: 'flat', sku: 'KIT-A', quantity: 4 }),
      rec({ source: 'flat', sku: 'KIT-B', location: 'WH-1', quantity: 0 }),
      rec({ source: 'flat', sku: 'GIFT-KIT', quantity: 2 }),
    ];
    const findings = bundleAvailability(records, { ...OPTS, bundles: [KIT] });
    // WH-1: computedMax = min(4, 0) = 0, listed 2 > 0 → critical at WH-1.
    const criticals = findings.filter((f) => f.severity === 'critical');
    expect(criticals).toHaveLength(1);
    expect(criticals[0]?.detail['location']).toBe('WH-1');
    // WH-2: computedMax = min(4, 5) = 4 vs listed 2 → drift warning.
    // flat's WH-1 bucket: bundle not listed there → silent.
    // flat's (no location) bucket: KIT-B missing → warning; KIT-A alone → computedMax 4 vs 2 → drift warning.
    expect(findings.some((f) => f.severity === 'warning' && f.detail['location'] === 'WH-2')).toBe(true);
    expect(findings.some((f) => f.rule === 'bundle-availability' && f.detail['missing'] !== undefined)).toBe(true);
  });

  it('matches component SKUs canonically (case/whitespace variants)', () => {
    const records = [
      rec({ source: 'a', sku: 'kit-a ', quantity: 6 }),
      rec({ source: 'a', sku: 'KIT-B', quantity: 6 }),
      rec({ source: 'a', sku: 'gift-kit', quantity: 3 }),
    ];
    const findings = bundleAvailability(records, { ...OPTS, bundles: [KIT] });
    // computedMax = min(6, 3) = 3 = listed → no findings.
    expect(findings).toEqual([]);
  });
});

describe('bundle-availability regression anchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('diagnose() output is byte-identical to the pre-bundle-era anchor when bundles is undefined', async () => {
    const anchor = await readFile('test/fixtures/diagnose-no-bundles-anchor.json', 'utf8');
    const { report } = await runDiff(
      [{ kind: 'csv', path: 'fixtures/shopify-store-a.csv' }, { kind: 'csv', path: 'fixtures/shopify-store-b.csv' }],
      { configPath: join(tmpdir(), 'no-such-inventory-doctor.json') },
    );
    expect(JSON.stringify(report)).toBe(anchor.trim());
  });

  it('diagnose() with explicit empty bundles matches the same anchor', async () => {
    const anchor = JSON.parse(await readFile('test/fixtures/diagnose-no-bundles-anchor.json', 'utf8')) as {
      findings: Array<{ rule: string }>;
    };
    expect(anchor.findings.length).toBeGreaterThan(0);
    expect(anchor.findings.some((f) => f.rule === 'bundle-availability')).toBe(false);
  });
});
