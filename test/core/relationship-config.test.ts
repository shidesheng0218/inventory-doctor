import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { explainSku, inventoryHealth, resolveDiagnoseOptions, runDiff } from '../../src/run.js';

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
    const emptyDir = await mkdtemp(join(tmpdir(), 'invdoc-relationship-'));
    const emptyConfig = join(emptyDir, 'inventory-doctor.json');
    await writeFile(emptyConfig, JSON.stringify({ stores: [] }));
    const defaultOptions = await resolveDiagnoseOptions({ configPath: emptyConfig });
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
    const noConfig = join(dir, 'no-config.json');
    await writeFile(noConfig, JSON.stringify({ stores: [] }));
    const explanation = await explainSku('X', [{ kind: 'csv', path: a }, { kind: 'csv', path: b }], {
      configPath: noConfig, diagnose: { inventoryRelationship: 'shared' },
    });
    const finding = explanation.findings.find((f) => f.rule === 'oversell-risk');
    expect(finding?.severity).toBe('critical');
    expect(finding?.evidence?.length).toBeGreaterThan(0);
    expect(finding?.risk).toBeTruthy();
    expect(finding?.assumptions).toContain('Inventory relationship: shared.');
    expect(finding?.verification?.length).toBeGreaterThan(0);
  });

  it.each(['explainSku', 'inventoryHealth'] as const)('%s rejects duplicate loaded source names', async (entrypoint) => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-source-names-'));
    try {
      const first = join(dir, 'first.csv');
      const second = join(dir, 'second.csv');
      await writeFile(first, 'sku,quantity\nX,1\n');
      await writeFile(second, 'sku,quantity\nX,2\n');
      const inputs = [{ kind: 'csv' as const, path: first, name: 'same' }, { kind: 'csv' as const, path: second, name: 'same' }];
      const result = entrypoint === 'explainSku' ? explainSku('X', inputs) : inventoryHealth(inputs);
      await expect(result).rejects.toThrow(/Duplicate source name "same"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
