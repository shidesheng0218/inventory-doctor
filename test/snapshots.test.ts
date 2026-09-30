import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSnapshots, loadSnapshot, saveSnapshot } from '../src/snapshots.js';
import { rec } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-test-'));
  process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = dir;
});

afterEach(async () => {
  delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('snapshot storage', () => {
  it('saves, lists, and loads a snapshot round-trip', async () => {
    const records = [rec({ source: 'store-a', sku: 'ABC-123', quantity: 5 })];
    const saved = await saveSnapshot('store-a', records, new Date('2026-09-01T08:00:00Z'));
    expect(saved.id).toBe('2026-09-01T08-00-00');
    expect(saved.recordCount).toBe(1);

    const list = await listSnapshots('store-a');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('2026-09-01T08-00-00');
    expect(list[0]?.savedAt).toBe('2026-09-01T08:00:00');

    const loaded = await loadSnapshot('store-a');
    expect(loaded.records).toHaveLength(1);
    // Records are re-tagged with the snapshot identity and timestamp.
    expect(loaded.records[0]?.source).toBe('store-a@2026-09-01T08-00-00');
    expect(loaded.records[0]?.meta['snapshotAt']).toBe('2026-09-01T08:00:00');
    expect(loaded.records[0]?.quantity).toBe(5);
  });

  it('resolves name@id-prefix and defaults to the latest snapshot', async () => {
    await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 1 })], new Date('2026-09-01T08:00:00Z'));
    await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 2 })], new Date('2026-09-02T08:00:00Z'));

    const latest = await loadSnapshot('s');
    expect(latest.records[0]?.quantity).toBe(2);

    const first = await loadSnapshot('s@2026-09-01');
    expect(first.records[0]?.quantity).toBe(1);
  });

  it('loads from a direct file path', async () => {
    const saved = await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 7 })], new Date('2026-09-03T08:00:00Z'));
    const loaded = await loadSnapshot(saved.path);
    expect(loaded.records[0]?.quantity).toBe(7);
  });

  it('errors with guidance when nothing is saved yet', async () => {
    await expect(loadSnapshot('nope')).rejects.toThrow(/snapshot save/);
    expect(await listSnapshots('nope')).toEqual([]);

    await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 1 })], new Date('2026-09-01T08:00:00Z'));
    await expect(loadSnapshot('s@2099-01-01')).rejects.toThrow(/Available:/);
  });

  it('never overwrites an existing snapshot — same-second saves get a suffix', async () => {
    const when = new Date('2026-09-01T08:00:00Z');
    const first = await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 1 })], when);
    const second = await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 2 })], when);
    expect(first.id).toBe('2026-09-01T08-00-00');
    expect(second.id).toBe('2026-09-01T08-00-00-2');

    const list = await listSnapshots('s');
    expect(list).toHaveLength(2);
    // The suffixed id still resolves to a comparable ISO timestamp.
    expect(list[1]?.savedAt).toBe('2026-09-01T08:00:00');
    expect((await loadSnapshot('s@2026-09-01T08-00-00')).records[0]?.quantity).toBe(1);
    expect((await loadSnapshot('s@2026-09-01T08-00-00-2')).records[0]?.quantity).toBe(2);
  });

  it('reports file and line when a snapshot file is corrupt', async () => {
    const saved = await saveSnapshot('s', [rec({ source: 's', sku: 'X', quantity: 1 })], new Date('2026-09-01T08:00:00Z'));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(saved.path, '{not json\n');
    await expect(loadSnapshot('s')).rejects.toThrow(/Corrupt snapshot file .*line 2/);
  });
});
