import { describe, expect, it } from 'vitest';
import { nightlyZero } from '../../src/core/rules/nightly-zero.js';
import { diagnose } from '../../src/core/diagnose.js';
import { rec } from '../helpers.js';

function snap(sku: string, quantity: number | null, at: string) {
  return rec({ source: `s@${at}`, sku, quantity, meta: { snapshotAt: at } });
}

const T1 = '2026-09-01T08:00:00';
const T2 = '2026-09-02T08:00:00';
const T3 = '2026-09-03T08:00:00';

describe('nightly-zero (time-series rule)', () => {
  it('flags a stable-stocked SKU that reads 0 in the latest snapshot', () => {
    const records = [
      snap('WIDGET-1', 12, T1),
      snap('WIDGET-1', 12, T2),
      snap('WIDGET-1', 0, T3),
    ];
    const findings = nightlyZero(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'nightly-zero', severity: 'critical', sku: 'WIDGET-1' });
    expect(findings[0]?.message).toContain('silently zeroed');
  });

  it('flags a SKU that vanishes from the latest snapshot', () => {
    // A snapshot timeline only exists where records carry it — another SKU
    // present in all three snapshots establishes the T1..T3 timeline.
    const records = [
      snap('GONE-1', 4, T1),
      snap('GONE-1', 4, T2),
      snap('OK-1', 1, T1),
      snap('OK-1', 1, T2),
      snap('OK-1', 1, T3),
    ];
    const findings = nightlyZero(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', sku: 'GONE-1' });
    expect(findings[0]?.message).toContain('missing from the latest');
  });

  it('warns on a sharper-than-sell-through drop that is not zero', () => {
    const records = [snap('DROP-1', 20, T1), snap('DROP-1', 18, T2), snap('DROP-1', 5, T3)];
    const findings = nightlyZero(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toContain('dropped from 18 to 5');
  });

  it('stays silent on gradual sell-through to zero (declining trend first)', () => {
    const records = [snap('SELL-1', 12, T1), snap('SELL-1', 4, T2), snap('SELL-1', 0, T3)];
    expect(nightlyZero(records)).toHaveLength(0);
  });

  it('stays silent when stock is stable or replenished', () => {
    const records = [snap('OK-1', 10, T1), snap('OK-1', 10, T2), snap('OK-1', 10, T3)];
    expect(nightlyZero(records)).toHaveLength(0);
  });

  it('needs at least three snapshots — two are just a diff', () => {
    const records = [snap('WIDGET-1', 12, T1), snap('WIDGET-1', 0, T2)];
    expect(nightlyZero(records)).toHaveLength(0);
  });

  it('is a no-op on ordinary two-source diffs (no snapshot tags)', () => {
    const report = diagnose([rec({ source: 'a', sku: 'X', quantity: 5 }), rec({ source: 'b', sku: 'X', quantity: 0 })]);
    expect(report.findings.filter((f) => f.rule === 'nightly-zero')).toHaveLength(0);
  });

  it('runs inside diagnose() when snapshot-tagged records are present', () => {
    const records = [
      snap('WIDGET-1', 12, T1),
      snap('WIDGET-1', 12, T2),
      snap('WIDGET-1', 0, T3),
    ];
    const report = diagnose(records);
    expect(report.findings.some((f) => f.rule === 'nightly-zero' && f.severity === 'critical')).toBe(true);
  });
});
