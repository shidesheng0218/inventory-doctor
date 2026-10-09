import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot } from '../src/snapshots.js';
import { skuHistory } from '../src/history.js';
import { rec } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-history-'));
  process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = dir;
});

afterEach(async () => {
  delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
  await rm(dir, { recursive: true, force: true });
});

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 9, 0, 0));

async function seedHistory(): Promise<void> {
  // SKU-1 drifts 5 → 5 → 0; SKU-2 stays present as a control.
  await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'SKU-1', quantity: 5 })], day(1));
  await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'SKU-1', quantity: 5 })], day(2));
  await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'SKU-1', quantity: 0 })], day(3));
}

describe('skuHistory', () => {
  it('returns one point per snapshot, in chronological order, zero preserved', async () => {
    await seedHistory();

    const history = await skuHistory('SKU-1', 'store-a');

    expect(history.sku).toBe('SKU-1');
    expect(history.canonical).toBe('sku-1');
    expect(history.found).toBe(true);
    expect(history.points).toHaveLength(3);
    expect(history.points.map((p) => p.quantity)).toEqual([5, 5, 0]);
    expect(history.points[2]?.quantity).toBe(0);
    expect(history.points[0]?.snapshotId).toBe('2026-01-01T09-00-00');
    expect(history.points[0]?.savedAt).toBe('2026-01-01T09:00:00');
  });

  it('honors maxSnapshots by loading only the newest N snapshots', async () => {
    await seedHistory();

    const history = await skuHistory('SKU-1', 'store-a', { maxSnapshots: 2 });

    expect(history.points).toHaveLength(2);
    expect(history.points.map((p) => p.quantity)).toEqual([5, 0]);
    expect(history.points[0]?.snapshotId).toBe('2026-01-02T09-00-00');
  });

  it('keeps a blank quantity as null — null is not zero', async () => {
    await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'SKU-1', quantity: 3 })], day(1));
    await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'SKU-1', quantity: null })], day(2));

    const history = await skuHistory('SKU-1', 'store-a');

    expect(history.points).toHaveLength(2);
    expect(history.points[1]?.quantity).toBeNull();
    expect(history.points[0]?.quantity).toBe(3);
  });

  it('expands points per location within one snapshot', async () => {
    await saveSnapshot(
      'store-a',
      [
        rec({ source: 'store-a', sku: 'SKU-1', location: 'Warehouse', quantity: 4 }),
        rec({ source: 'store-a', sku: 'SKU-1', location: 'Storefront', quantity: 1 }),
      ],
      day(1),
    );

    const history = await skuHistory('SKU-1', 'store-a');

    expect(history.points).toHaveLength(2);
    const locations = history.points.map((p) => p.location).sort();
    expect(locations).toEqual(['Storefront', 'Warehouse']);
  });

  it('matches canonically, not by raw string', async () => {
    await saveSnapshot('store-a', [rec({ source: 'store-a', sku: 'ABC-123', quantity: 7 })], day(1));

    const history = await skuHistory('abc-123', 'store-a');

    expect(history.found).toBe(true);
    expect(history.points).toHaveLength(1);
    expect(history.points[0]?.quantity).toBe(7);
  });

  it('returns found=false with an empty points array when the SKU never appears', async () => {
    await seedHistory();

    const history = await skuHistory('NOPE-404', 'store-a');

    expect(history.found).toBe(false);
    expect(history.points).toEqual([]);
  });

  it('errors with guidance when no snapshots exist yet', async () => {
    await expect(skuHistory('SKU-1', 'nope')).rejects.toThrow(/snapshot save/);
  });
});
