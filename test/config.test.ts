import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStore, loadConfig, resolveSecret } from '../src/config.js';

describe('config', () => {
  it('loads stores and validates credential modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(
      path,
      JSON.stringify({
        stores: [
          { name: 'store-a', domain: 'a.myshopify.com', accessToken: 'env:STORE_A_TOKEN' },
          { name: 'store-b', domain: 'b.myshopify.com', clientId: 'env:B_ID', clientSecret: 'env:B_SECRET' },
        ],
      }),
    );
    const config = await loadConfig(path);
    expect(config.stores).toHaveLength(2);
    expect(findStore(config, 'store-b').domain).toBe('b.myshopify.com');
    expect(() => findStore(config, 'nope')).toThrow(/not found/);
  });

  it('rejects stores without any credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invdoc-'));
    const path = join(dir, 'inventory-doctor.json');
    await writeFile(path, JSON.stringify({ stores: [{ name: 'x', domain: 'x.myshopify.com' }] }));
    await expect(loadConfig(path)).rejects.toThrow(/no credentials/);
  });

  it('resolves "env:VAR_NAME" references against process.env', () => {
    process.env['INV_DOC_TEST_TOKEN'] = 'shpat_secret';
    expect(resolveSecret('env:INV_DOC_TEST_TOKEN')).toBe('shpat_secret');
    expect(resolveSecret('shpat_inline')).toBe('shpat_inline');
    expect(() => resolveSecret('env:INV_DOC_MISSING_VAR')).toThrow(/INV_DOC_MISSING_VAR/);
  });
});
