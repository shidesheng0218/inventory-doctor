import { describe, expect, it } from 'vitest';
import { diagnose } from '../../src/core/diagnose.js';
import { oversellRisk } from '../../src/core/rules/oversell-risk.js';
import { oversold } from '../../src/core/rules/oversold.js';
import { nightlyZero } from '../../src/core/rules/nightly-zero.js';
import { bundleAvailability } from '../../src/core/rules/bundle-availability.js';
import { DEFAULT_DIAGNOSE_OPTIONS as defaults } from '../../src/core/types.js';
import { rec } from '../helpers.js';

const difference = [rec({ source: 'a', sku: 'X', quantity: 0 }), rec({ source: 'b', sku: 'X', quantity: 20 })];

describe('facts and conditional risk', () => {
  it('defaults to unknown and retains quantity facts with lower urgency', () => {
    expect(defaults.inventoryRelationship).toBe('unknown');
    const [finding] = oversellRisk(difference);
    expect(finding?.severity).toBe('warning');
    expect(finding?.detail).toMatchObject({ quantityA: 0, quantityB: 20 });
    expect(finding?.assumptions).toContain('Inventory relationship: unknown.');
    expect(finding?.suggestion).not.toMatch(/Push the real quantity/);
    expect(finding?.message).not.toMatch(/oversold|selling stock you/);
  });

  it('shared retains original severe and mild threshold behavior', () => {
    const options = { ...defaults, inventoryRelationship: 'shared' as const };
    expect(oversellRisk(difference, options)[0]?.severity).toBe('critical');
    expect(oversellRisk([rec({ source: 'a', sku: 'X', quantity: 100 }), rec({ source: 'b', sku: 'X', quantity: 92 })], options)[0]?.severity).toBe('warning');
    expect(oversellRisk([rec({ source: 'a', sku: 'X', quantity: 100 }), rec({ source: 'b', sku: 'X', quantity: 50 })], options)[0]?.severity).toBe('critical');
  });

  it('independent skips cross-store risk while preserving comparison facts and local policy facts', () => {
    const options = { ...defaults, inventoryRelationship: 'independent' as const };
    expect(oversellRisk(difference, options)).toEqual([]);
    const report = diagnose(difference, options);
    expect(report.healthSummary.severeDrift).toBe(1);
    expect(report.findings.some((f) => f.rule === 'quantity-drift')).toBe(true);
    const [policy] = oversellRisk([rec({ source: 'a', sku: 'X', quantity: 0, meta: { inventoryPolicy: 'continue' } })], options);
    expect(policy?.detail['inventoryPolicy']).toBe('continue');
  });

  it('intentional backorders retain negative and policy observations with reduced urgency', () => {
    const options = { ...defaults, allowBackorders: true, inventoryRelationship: 'shared' as const };
    const [negative] = oversold([rec({ source: 'a', sku: 'X', quantity: -2 })], options);
    expect(negative?.severity).toBe('info');
    expect(negative?.detail['quantity']).toBe(-2);
    expect(negative?.risk).toContain('does not prove');
    expect(oversellRisk(difference, options)[0]?.severity).toBe('warning');
    expect(oversellRisk([rec({ source: 'a', sku: 'X', quantity: 0, meta: { inventoryPolicy: 'continue' } })], options)[0]?.severity).toBe('info');
  });

  it('does not lose negative observations from another source with the same SKU/location', () => {
    const findings = oversold([rec({ source: 'a', sku: 'X', quantity: -2 }), rec({ source: 'b', sku: 'X', quantity: -3 })]);
    expect(findings.map((f) => f.detail['source'])).toEqual(['a', 'b']);
  });

  it('diagnose completes every finding and retains fields through severity overrides', () => {
    const report = diagnose([...difference, rec({ source: 'a', sku: 'BLANK', quantity: null, quantityRaw: '', cellIsBlank: true })], {
      ...defaults, severityOverrides: { 'oversell-risk': 'info' },
    });
    for (const finding of report.findings) {
      expect(finding.evidence?.length).toBeGreaterThan(0);
      expect(finding.risk).toBeTruthy();
      expect(finding.assumptions?.length).toBeGreaterThan(0);
      expect(finding.verification?.length).toBeGreaterThan(0);
    }
    expect(report.findings.find((f) => f.rule === 'oversell-risk')?.severity).toBe('info');
  });

  it('nightlyZero supplies its own evidence without claiming a cause even when called directly', () => {
    const snapshots = [12, 12, 0].map((quantity, i) => rec({ source: 's', sku: 'X', quantity, meta: { snapshotAt: `2026-10-0${i + 1}` } }));
    const [finding] = nightlyZero(snapshots);
    expect(finding?.evidence?.length).toBeGreaterThan(0);
    expect(finding?.risk).toContain('cause is not established');
    expect(finding?.assumptions?.length).toBeGreaterThan(0);
    expect(finding?.verification?.length).toBeGreaterThan(0);
    expect(finding?.message).not.toContain('silently zeroed');
  });

  it('does not turn a nonnumeric component into zero assembly capacity', () => {
    const findings = bundleAvailability([
      rec({ source: 'a', sku: 'KIT', quantity: 10 }),
      rec({ source: 'a', sku: 'PART', quantity: null }),
    ], { ...defaults, bundles: [{ sku: 'KIT', components: [{ sku: 'PART', quantity: 1 }] }] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail['missing']).toEqual(['PART']);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.detail['computedMax']).toBeUndefined();
  });

  it('negative component stock gives a zero bound and backorders reduce bundle urgency', () => {
    const records = [rec({ source: 'a', sku: 'KIT', quantity: 10 }), rec({ source: 'a', sku: 'PART', quantity: -2 })];
    const options = { ...defaults, bundles: [{ sku: 'KIT', components: [{ sku: 'PART', quantity: 1 }] }] };
    expect(bundleAvailability(records, options)[0]?.detail['computedMax']).toBe(0);
    const [finding] = bundleAvailability(records, { ...options, allowBackorders: true });
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).not.toContain('cannot be fulfilled');
    expect(finding?.assumptions).toContain('Intentional backorders: true.');
  });
});
