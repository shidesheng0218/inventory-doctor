import { describe, expect, it } from 'vitest';
import { isPrefixSuffixPair, pairPrefixSuffixVariants, skuMismatch } from '../../src/core/rules/sku-mismatch.js';
import { oversellRisk } from '../../src/core/rules/oversell-risk.js';
import { blankVsZero } from '../../src/core/rules/blank-vs-zero.js';
import { barcodeCrosscheck } from '../../src/core/rules/barcode-crosscheck.js';
import { computeHealthSummary, healthScore, quantityDrift } from '../../src/core/rules/quantity-drift.js';
import { untracked } from '../../src/core/rules/untracked.js';
import { rec } from '../helpers.js';

describe('R1 sku-mismatch', () => {
  it('flags case-only mismatch as warning', () => {
    const findings = skuMismatch([rec({ source: 'a', sku: 'ABC-123' }), rec({ source: 'b', sku: 'abc-123' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.detail['kind']).toBe('case');
  });

  it('flags whitespace/invisible mismatch as warning', () => {
    const findings = skuMismatch([rec({ source: 'a', sku: 'ABC-123' }), rec({ source: 'b', sku: 'ABC-123 ' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail['kind']).toBe('whitespace');
  });

  it('detects prefix/suffix variants as info instead of orphan', () => {
    const findings = skuMismatch([rec({ source: 'a', sku: 'ABC-123' }), rec({ source: 'b', sku: 'SHOP-ABC-123' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.detail['kind']).toBe('prefix-suffix');
  });

  it('flags true orphans as critical on both sides', () => {
    const findings = skuMismatch([rec({ source: 'a', sku: 'ONLY-A' }), rec({ source: 'b', sku: 'ONLY-B' })]);
    const orphans = findings.filter((f) => f.detail['kind'] === 'orphan');
    expect(orphans).toHaveLength(2);
    expect(orphans.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('flags one-to-many duplicates within a single source as critical', () => {
    const findings = skuMismatch([
      rec({ source: 'a', sku: 'DUP-1', quantity: 4, quantityRaw: '4' }),
      rec({ source: 'a', sku: 'DUP-1', quantity: 9, quantityRaw: '9' }),
      rec({ source: 'b', sku: 'DUP-1', quantity: 9, quantityRaw: '9' }),
    ]);
    const dup = findings.find((f) => f.message.includes('appears 2 times'));
    expect(dup?.severity).toBe('critical');
  });

  it('does not flag duplicates with identical quantities', () => {
    const findings = skuMismatch([
      rec({ source: 'a', sku: 'SAME-1', quantity: 4, quantityRaw: '4' }),
      rec({ source: 'a', sku: 'SAME-1', quantity: 4, quantityRaw: '4' }),
      rec({ source: 'b', sku: 'SAME-1', quantity: 8, quantityRaw: '8' }),
    ]);
    expect(findings.find((f) => f.message.includes('appears 2 times'))).toBeUndefined();
  });
});

describe('R2 oversell-risk', () => {
  it('flags qty <= 0 in one source vs > 0 in the other as critical', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'X-1', quantity: 0, quantityRaw: '0' }),
      rec({ source: 'b', sku: 'X-1', quantity: 8, quantityRaw: '8' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.message).toContain('out of stock');
  });

  it('warns on continue-selling policy with qty <= 0', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'X-2', quantity: 0, quantityRaw: '0', meta: { inventoryPolicy: 'continue' } }),
      rec({ source: 'b', sku: 'X-2', quantity: 0, quantityRaw: '0' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toContain('continue selling');
  });

  it('flags drift beyond thresholds, graded by magnitude', () => {
    const mild = oversellRisk([
      rec({ source: 'a', sku: 'X-3', quantity: 100, quantityRaw: '100' }),
      rec({ source: 'b', sku: 'X-3', quantity: 92, quantityRaw: '92' }),
    ]);
    expect(mild[0]?.severity).toBe('warning');

    const severe = oversellRisk([
      rec({ source: 'a', sku: 'X-4', quantity: 100, quantityRaw: '100' }),
      rec({ source: 'b', sku: 'X-4', quantity: 50, quantityRaw: '50' }),
    ]);
    expect(severe[0]?.severity).toBe('critical');
  });

  it('stays silent within thresholds', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'X-5', quantity: 100, quantityRaw: '100' }),
      rec({ source: 'b', sku: 'X-5', quantity: 97, quantityRaw: '97' }),
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe('R3 blank-vs-zero', () => {
  it('treats a blank cell and an explicit "0" differently — the core capability', () => {
    const findings = blankVsZero([
      rec({ source: 'a', sku: 'BLANK-1', quantity: null, quantityRaw: '' }),
      rec({ source: 'a', sku: 'ZERO-1', quantity: 0, quantityRaw: '0' }),
      rec({ source: 'b', sku: 'BLANK-1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'ZERO-1', quantity: 0, quantityRaw: '0' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sku).toBe('BLANK-1');
    expect(findings[0]?.severity).toBe('critical');
  });

  it('flags whitespace-only cells as blank too', () => {
    const findings = blankVsZero([rec({ source: 'a', sku: 'W-1', quantity: null, quantityRaw: '   ' })]);
    expect(findings).toHaveLength(1);
  });
});

describe('R4 barcode-crosscheck', () => {
  it('flags same barcode with different SKUs across sources as critical', () => {
    const findings = barcodeCrosscheck([
      rec({ source: 'a', sku: 'BC-A', barcode: '999' }),
      rec({ source: 'b', sku: 'BC-B', barcode: '999' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });

  it('ignores same barcode with the same SKU', () => {
    const findings = barcodeCrosscheck([
      rec({ source: 'a', sku: 'BC-1', barcode: '999' }),
      rec({ source: 'b', sku: 'bc-1', barcode: '999' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('ignores barcode conflicts inside a single source', () => {
    const findings = barcodeCrosscheck([
      rec({ source: 'a', sku: 'BC-1', barcode: '999' }),
      rec({ source: 'a', sku: 'BC-2', barcode: '999' }),
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe('R5 quantity-drift', () => {
  it('computes the health distribution and score', () => {
    const records = [
      rec({ source: 'a', sku: 'OK-1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'b', sku: 'OK-1', quantity: 5, quantityRaw: '5' }),
      rec({ source: 'a', sku: 'MINOR-1', quantity: 10, quantityRaw: '10' }),
      rec({ source: 'b', sku: 'MINOR-1', quantity: 9, quantityRaw: '9' }),
      rec({ source: 'a', sku: 'BAD-1', quantity: 100, quantityRaw: '100' }),
      rec({ source: 'b', sku: 'BAD-1', quantity: 10, quantityRaw: '10' }),
      rec({ source: 'a', sku: 'LONELY-1', quantity: 3, quantityRaw: '3' }),
    ];
    const summary = computeHealthSummary(records);
    expect(summary).toEqual({ matched: 1, minorDrift: 1, severeDrift: 1, unmatched: 1, totalCompared: 4 });
    expect(healthScore(summary)).toBe(Math.round(((1 + 0.5) / 4) * 100));

    const findings = quantityDrift(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.message).toContain('Sync health score');
  });
});

describe('R6 untracked', () => {
  it('flags untracked SKUs that another source manages', () => {
    const findings = untracked([
      rec({ source: 'a', sku: 'U-1', quantity: 6, quantityRaw: '6', tracked: false }),
      rec({ source: 'b', sku: 'U-1', quantity: 6, quantityRaw: '6', tracked: true }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
  });

  it('ignores untracked SKUs nobody else manages', () => {
    const findings = untracked([rec({ source: 'a', sku: 'U-2', tracked: false })]);
    expect(findings).toHaveLength(0);
  });
});
