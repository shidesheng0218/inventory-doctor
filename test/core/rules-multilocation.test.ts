import { describe, expect, it } from 'vitest';
import { oversellRisk } from '../../src/core/rules/oversell-risk.js';
import { computeHealthSummary } from '../../src/core/rules/quantity-drift.js';
import { isPrefixSuffixPair, pairPrefixSuffixVariants, skuMismatch } from '../../src/core/rules/sku-mismatch.js';
import { rec } from '../helpers.js';

describe('R1 one-to-many: location-aware bucketing', () => {
  it('does NOT flag a normal multi-location SKU (one row per location)', () => {
    const findings = skuMismatch([
      rec({ source: 'a', sku: 'M-1', location: 'Warehouse A', quantity: 10, quantityRaw: '10' }),
      rec({ source: 'a', sku: 'M-1', location: 'Warehouse B', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'M-1', location: 'Warehouse A', quantity: 10, quantityRaw: '10' }),
      rec({ source: 'b', sku: 'M-1', location: 'Warehouse B', quantity: 5, quantityRaw: '5' }),
    ]);
    expect(findings.filter((f) => f.message.includes('appears'))).toHaveLength(0);
  });

  it('still flags a true duplicate at the same (sku, location) as critical', () => {
    const findings = skuMismatch([
      rec({ source: 'a', sku: 'M-2', location: 'Warehouse A', quantity: 4, quantityRaw: '4' }),
      rec({ source: 'a', sku: 'M-2', location: 'Warehouse A', quantity: 9, quantityRaw: '9' }),
      rec({ source: 'b', sku: 'M-2', location: 'Warehouse A', quantity: 9, quantityRaw: '9' }),
    ]);
    const dup = findings.find((f) => f.message.includes('appears 2 times'));
    expect(dup?.severity).toBe('critical');
    expect(dup?.message).toContain('at location "Warehouse A"');
  });
});

describe('R2 oversell-risk: location-aligned comparison', () => {
  it('surfaces a location-level oversell that cross-location summing would hide', () => {
    // Summed across locations both sides total 6 — but Warehouse A is 0 vs 6.
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'M-3', location: 'Warehouse A', quantity: 0, quantityRaw: '0' }),
      rec({ source: 'a', sku: 'M-3', location: 'Warehouse B', quantity: 6, quantityRaw: '6' }),
      rec({ source: 'b', sku: 'M-3', location: 'Warehouse A', quantity: 6, quantityRaw: '6' }),
      rec({ source: 'b', sku: 'M-3', location: 'Warehouse B', quantity: 0, quantityRaw: '0' }),
    ]);
    const oversell = findings.filter((f) => f.message.includes('out of stock'));
    expect(oversell).toHaveLength(2);
    expect(oversell.map((f) => f.detail['location'])).toEqual(['Warehouse A', 'Warehouse B']);
  });

  it('reports location-level drift only for the drifting location', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'M-4', location: 'Warehouse A', quantity: 20, quantityRaw: '20' }),
      rec({ source: 'a', sku: 'M-4', location: 'Warehouse B', quantity: 3, quantityRaw: '3' }),
      rec({ source: 'b', sku: 'M-4', location: 'Warehouse A', quantity: 12, quantityRaw: '12' }),
      rec({ source: 'b', sku: 'M-4', location: 'Warehouse B', quantity: 3, quantityRaw: '3' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail['location']).toBe('Warehouse A');
  });

  it('falls back to per-sku vs cross-location sum when one side has no locations', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'M-5', quantity: 15, quantityRaw: '15' }),
      rec({ source: 'b', sku: 'M-5', location: 'Warehouse A', quantity: 10, quantityRaw: '10' }),
      rec({ source: 'b', sku: 'M-5', location: 'Warehouse B', quantity: 5, quantityRaw: '5' }),
    ]);
    expect(findings).toHaveLength(0); // 15 == 10 + 5, perfectly in sync
  });
});

describe('R5 quantity-drift: location-aligned units', () => {
  it('counts per (sku, location) when both sources have locations', () => {
    const summary = computeHealthSummary([
      rec({ source: 'a', sku: 'M-6', location: 'L1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'a', sku: 'M-6', location: 'L2', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'M-6', location: 'L1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'M-6', location: 'L2', quantity: 50, quantityRaw: '50' }),
    ]);
    expect(summary).toEqual({ matched: 1, minorDrift: 0, severeDrift: 1, unmatched: 0, totalCompared: 2 });
  });

  it('counts a location present on only one side as unmatched', () => {
    const summary = computeHealthSummary([
      rec({ source: 'a', sku: 'M-7', location: 'L1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'M-7', location: 'L1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'M-7', location: 'L2', quantity: 9, quantityRaw: '9' }),
    ]);
    expect(summary).toEqual({ matched: 1, minorDrift: 0, severeDrift: 0, unmatched: 1, totalCompared: 2 });
  });
});

describe('R1 prefix/suffix heuristic tightening', () => {
  it('requires a strict prefix/suffix with affix >= 2 chars', () => {
    expect(isPrefixSuffixPair('abc-123', 'shop-abc-123')).toBe(true); // prefix "shop-"
    expect(isPrefixSuffixPair('abc-123', 'abc-123-us')).toBe(true); // suffix "-us"
    expect(isPrefixSuffixPair('a-1', 'a-11')).toBe(false); // affix "1" too short
    expect(isPrefixSuffixPair('abc-123', 'x-abc-124')).toBe(false); // not a strict prefix/suffix
    expect(isPrefixSuffixPair('abc', 'abc')).toBe(false); // equal strings are not variants
  });

  it('does not pair A-1 with A-11; still pairs SHOP-ABC-123 with ABC-123', () => {
    const { pairs, remainingA } = pairPrefixSuffixVariants(['a-1', 'abc-123'], ['a-11', 'shop-abc-123']);
    expect(pairs).toEqual([['abc-123', 'shop-abc-123']]);
    expect(remainingA).toEqual(['a-1']);
  });

  it('end-to-end: A-1 vs A-11 become orphans (critical), not a prefix/suffix info', () => {
    const findings = skuMismatch([rec({ source: 'a', sku: 'A-1' }), rec({ source: 'b', sku: 'A-11' })]);
    expect(findings.filter((f) => f.detail['kind'] === 'prefix-suffix')).toHaveLength(0);
    expect(findings.filter((f) => f.detail['kind'] === 'orphan')).toHaveLength(2);
  });
});
