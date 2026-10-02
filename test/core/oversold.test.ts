import { describe, expect, it } from 'vitest';
import { oversold } from '../../src/core/rules/oversold.js';
import { oversellRisk } from '../../src/core/rules/oversell-risk.js';
import { diagnose } from '../../src/core/diagnose.js';
import { rec } from '../helpers.js';

// These two checks are what a single-store deployment can say on day one.
// Everything else in R2 compared two systems against each other.

describe('R8 oversold (negative availability)', () => {
  it('reports how badly the SKU is oversold, per location', () => {
    const findings = oversold([rec({ source: 'shop', sku: 'SKU-1', quantity: -3, location: 'Main' })]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'oversold', severity: 'critical', sku: 'SKU-1' });
    expect(findings[0]?.message).toContain('oversold by 3 units');
    expect(findings[0]?.detail['short']).toBe(3);
    expect(findings[0]?.detail['location']).toBe('Main');
  });

  it('uses the singular for a one-unit oversell', () => {
    const findings = oversold([rec({ source: 'shop', sku: 'SKU-1', quantity: -1 })]);
    expect(findings[0]?.message).toContain('oversold by 1 unit ');
  });

  it('keeps two oversold shelves as two separate problems', () => {
    const findings = oversold([
      rec({ source: 'shop', sku: 'SKU-1', quantity: -2, location: 'Warehouse A' }),
      rec({ source: 'shop', sku: 'SKU-1', quantity: -5, location: 'Warehouse B' }),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.detail['short'])).toEqual([2, 5]);
  });

  it('treats repeated rows for the same shelf as one problem', () => {
    const findings = oversold([
      rec({ source: 'shop', sku: 'SKU-1', quantity: -2, location: 'Main' }),
      rec({ source: 'shop', sku: 'SKU-1', quantity: -2, location: 'Main' }),
    ]);
    expect(findings).toHaveLength(1);
  });

  it('ignores zero, positive and blank quantities', () => {
    const findings = oversold([
      rec({ source: 'shop', sku: 'A', quantity: 0 }),
      rec({ source: 'shop', sku: 'B', quantity: 4 }),
      rec({ source: 'shop', sku: 'C', quantity: null, quantityRaw: '' }),
    ]);
    expect(findings).toEqual([]);
  });

  it('fires without any second source, which is the point', () => {
    const report = diagnose([rec({ source: 'shop', sku: 'SKU-1', quantity: -2 })]);
    const oversoldFindings = report.findings.filter((f) => f.rule === 'oversold');

    expect(oversoldFindings).toHaveLength(1);
    expect(oversoldFindings[0]?.severity).toBe('critical');
    expect(report.healthScore).toBe(100); // nothing to compare, but still a real finding
  });
});

describe('R2 continue-selling on a single source', () => {
  it('fires even though there is nothing to compare against', () => {
    const findings = oversellRisk([
      rec({ source: 'shop', sku: 'SKU-1', quantity: 0, meta: { inventoryPolicy: 'continue' } }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('continue selling');
    // Single-source wording: there is no "other source" to blame.
    expect(findings[0]?.suggestion).toContain('orders are accepted');
  });

  it('reports the row once even when several sources carry it', () => {
    const findings = oversellRisk([
      rec({ source: 'a', sku: 'SKU-1', quantity: 0, meta: { inventoryPolicy: 'continue' } }),
      rec({ source: 'b', sku: 'SKU-1', quantity: 0, meta: { inventoryPolicy: 'continue' } }),
      rec({ source: 'c', sku: 'SKU-1', quantity: 0, meta: { inventoryPolicy: 'continue' } }),
    ]);
    const policy = findings.filter((f) => f.message.includes('continue selling'));

    expect(policy).toHaveLength(1);
    // Multi-source wording is kept for the two-system case.
    expect(policy[0]?.suggestion).toContain('the other source does not also count');
  });

  it('stays quiet while stock is on hand', () => {
    const findings = oversellRisk([
      rec({ source: 'shop', sku: 'SKU-1', quantity: 3, meta: { inventoryPolicy: 'continue' } }),
    ]);
    expect(findings.filter((f) => f.message.includes('continue selling'))).toEqual([]);
  });

  it('stays quiet when the policy is deny', () => {
    const findings = oversellRisk([
      rec({ source: 'shop', sku: 'SKU-1', quantity: 0, meta: { inventoryPolicy: 'deny' } }),
    ]);
    expect(findings).toEqual([]);
  });
});
