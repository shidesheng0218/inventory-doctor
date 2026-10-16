import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { explainSku, resolveDiagnoseOptions, runDiff } from '../../src/run.js';

describe('inventory relationship configuration', () => {
  it('validates and loads rules fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-relationship-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [], rules: { inventoryRelationship: 'independent', allowBackorders: true } }));
    const config = await loadConfig(path);
    expect(config.rules).toMatchObject({ inventoryRelationship: 'independent', allowBackorders: true });
  });

  it('rejects invalid relationship and backorder values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-relationship-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [], rules: { inventoryRelationship: 'separate' } }));
    await expect(loadConfig(path)).rejects.toThrow(/inventoryRelationship/);
    await writeFile(path, JSON.stringify({ stores: [], rules: { allowBackorders: 'yes' } }));
    await expect(loadConfig(path)).rejects.toThrow(/allowBackorders/);
  });

  it('resolveDiagnoseOptions defaults unknown and merges config then explicit options', async () => {
    const defaultOptions = await resolveDiagnoseOptions({ configPath: join(tmpdir(), 'missing-inventory-doctor.json') });
    expect(defaultOptions.inventoryRelationship).toBe('unknown');
    expect(defaultOptions.allowBackorders).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-relationship-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [], rules: { inventoryRelationship: 'independent', allowBackorders: true } }));
    const configured = await resolveDiagnoseOptions({ configPath: path });
    expect(configured).toMatchObject({ inventoryRelationship: 'independent', allowBackorders: true });
    const overridden = await resolveDiagnoseOptions({ configPath: path, diagnose: { inventoryRelationship: 'shared', allowBackorders: false } });
    expect(overridden).toMatchObject({ inventoryRelationship: 'shared', allowBackorders: false });
  });
  it('explainSku exposes evidence fields and respects explicit premises', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-explain-'));
    const a = join(dir, 'a.csv');
    const b = join(dir, 'b.csv');
    await writeFile(a, 'sku,quantity\nX,0\n');
    await writeFile(b, 'sku,quantity\nX,8\n');
    const explanation = await explainSku('X', [{ kind: 'csv', path: a }, { kind: 'csv', path: b }], {
      configPath: join(dir, 'no-config.json'), diagnose: { inventoryRelationship: 'shared' },
    });
    const finding = explanation.findings.find((f) => f.rule === 'oversell-risk');
    expect(finding?.severity).toBe('critical');
    expect(finding?.evidence?.length).toBeGreaterThan(0);
    expect(finding?.risk).toBeTruthy();
    expect(finding?.assumptions).toContain('Inventory relationship: shared.');
    expect(finding?.verification?.length).toBeGreaterThan(0);
  });

  it('config applies and explicit diagnose options win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-relationship-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [], rules: { inventoryRelationship: 'independent', allowBackorders: true } }));
    const inputs = [{ kind: 'csv' as const, path: 'fixtures/shopify-store-a.csv' }, { kind: 'csv' as const, path: 'fixtures/shopify-store-b.csv' }] as const;
    const configured = await runDiff([...inputs], { configPath: path });
    expect(configured.report.findings.filter((f) => f.rule === 'oversell-risk' && f.detail['sourceA']).length).toBe(0);
    const overridden = await runDiff([...inputs], { configPath: path, diagnose: { inventoryRelationship: 'shared', allowBackorders: false } });
    expect(overridden.report.findings.some((f) => f.rule === 'oversell-risk' && f.detail['sourceA'])).toBe(true);
  });
});
