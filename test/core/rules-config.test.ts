import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, globToRegExp } from '../../src/core/diagnose.js';
import { runDiff } from '../../src/run.js';
import { loadConfig } from '../../src/config.js';
import { rec } from '../helpers.js';

const A = 'fixtures/shopify-store-a.csv';
const B = 'fixtures/shopify-store-b.csv';

describe('rules configuration', () => {
  it('disable removes a rule entirely', () => {
    const records = [
      rec({ source: 'a', sku: 'X-1', quantity: 0 }),
      rec({ source: 'b', sku: 'X-1', quantity: 9 }),
    ];
    const withRule = diagnose(records);
    expect(withRule.findings.some((f) => f.rule === 'oversell-risk')).toBe(true);

    const without = diagnose(records, { driftAbsThreshold: 5, driftPctThreshold: 0.2, disabledRules: ['oversell-risk'] });
    expect(without.findings.some((f) => f.rule === 'oversell-risk')).toBe(false);
  });

  it('ignoreSkus drops findings whose canonical SKU matches a glob', () => {
    const records = [
      rec({ source: 'a', sku: 'GIFT-100', quantity: 0 }),
      rec({ source: 'b', sku: 'gift-100 ', quantity: 9 }), // canonical match must still be ignored
      rec({ source: 'a', sku: 'REAL-1', quantity: 0 }),
      rec({ source: 'b', sku: 'REAL-1', quantity: 9 }),
    ];
    const findings = diagnose(records, {
      driftAbsThreshold: 5,
      driftPctThreshold: 0.2,
      ignoreSkus: ['GIFT-*'],
    }).findings;
    expect(findings.some((f) => f.sku === 'GIFT-100' || f.sku === 'gift-100 ')).toBe(false);
    expect(findings.some((f) => f.sku === 'REAL-1')).toBe(true);
  });

  it('severityOverrides forces a rule to a different severity', () => {
    const records = [
      rec({ source: 'a', sku: 'X-1', quantity: null, quantityRaw: '' }),
      rec({ source: 'b', sku: 'X-1', quantity: 3 }),
    ];
    const findings = diagnose(records, {
      driftAbsThreshold: 5,
      driftPctThreshold: 0.2,
      severityOverrides: { 'blank-vs-zero': 'warning' },
    }).findings;
    const blank = findings.find((f) => f.rule === 'blank-vs-zero');
    expect(blank?.severity).toBe('warning');
  });

  it('globToRegExp escapes regex metacharacters', () => {
    expect(globToRegExp('A.B*').test('a.b-c')).toBe(true); // canonical: case-folded
    expect(globToRegExp('A.B*').test('aXb-c')).toBe(false); // "." is literal
    expect(globToRegExp('SKU-?').test('sku-1')).toBe(true);
    expect(globToRegExp('SKU-?').test('sku-12')).toBe(false);
  });

  it('config validation rejects unknown rules and bad severities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-rules-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [], rules: { disable: ['not-a-rule'] } }));
    await expect(loadConfig(path)).rejects.toThrow(/unknown rule/);

    await writeFile(path, JSON.stringify({ stores: [], rules: { severityOverrides: { 'untracked': 'fatal' } } }));
    await expect(loadConfig(path)).rejects.toThrow(/severity/);
  });

  it('runDiff applies config rules; CLI flags beat config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-rules-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(
      path,
      JSON.stringify({
        stores: [],
        rules: { disable: ['untracked'], ignoreSkus: ['BLANK-*'], driftAbsThreshold: 1000 },
      }),
    );

    // Config: untracked off, BLANK-1 ignored, drift threshold huge → DRIFT-1 quiet.
    const { report } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }], { configPath: path });
    expect(report.findings.some((f) => f.rule === 'untracked')).toBe(false);
    expect(report.findings.some((f) => f.sku === 'BLANK-1')).toBe(false);
    expect(report.findings.some((f) => f.message.includes('differs by 8'))).toBe(false);

    // CLI flag overrides the config threshold → DRIFT-1 fires again.
    const cli = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }], {
      configPath: path,
      diagnose: { driftAbsThreshold: 5 },
    });
    expect(cli.report.findings.some((f) => f.message.includes('differs by 8'))).toBe(true);
  });

  it('CSV-only diff without any config file still works', async () => {
    const { report } = await runDiff([{ kind: 'csv', path: A }, { kind: 'csv', path: B }], {
      configPath: join(tmpdir(), 'definitely-does-not-exist-inventory-doctor.json'),
    });
    expect(report.findings.length).toBeGreaterThan(0);
  });
});
