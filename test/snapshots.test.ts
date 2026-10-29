import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSnapshots, listSnapshotStubs, loadSnapshot, planPruneSnapshots, pruneSnapshots, saveSnapshot, SnapshotPruneError } from '../src/snapshots.js';
import { diagnose } from '../src/core/diagnose.js';
import type { InventoryRecord } from '../src/core/types.js';
import { rec } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inventory-doctor-test-'));
  process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = dir;
});

afterEach(async () => {
  vi.restoreAllMocks();
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

  it('lists snapshot stubs without reading snapshot contents', async () => {
    const saved = await saveSnapshot('stubs', [rec({ source: 'stubs', sku: 'X', quantity: 3 })], new Date('2026-09-01T08:00:00Z'));
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const stubs = await listSnapshotStubs('stubs');
    expect(stubs).toEqual([{ id: saved.id, path: saved.path, savedAt: saved.savedAt.slice(0, 19) }]);
    expect(readFileSpy).not.toHaveBeenCalled();
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


  it('keeps explicit values and conservatively marks legacy blank provenance unknown', async () => {
    const saved = await saveSnapshot('legacy', [{ source: 'legacy', sku: 'X', quantity: 0, quantityRaw: '', barcode: null, title: null, location: null, tracked: true, cellIsBlank: false, meta: {} } as InventoryRecord]);
    const loaded = await loadSnapshot(saved.path);
    expect(loaded.records[0]?.cellIsBlank).toBe(false);
    await writeFile(saved.path, JSON.stringify({ source: 'legacy', sku: 'X', quantity: 0, quantityRaw: '', meta: {} }) + '\n');
    const legacy = await loadSnapshot(saved.path);
    expect(legacy.records[0]?.cellIsBlank).toBeNull();
    expect(legacy.warnings.length).toBeGreaterThan(0);
    expect(legacy.records[0]?.meta['snapshotWarning']).toMatch(/treated as null/);
    expect(diagnose(legacy.records).findings.find((finding) => finding.rule === 'blank-vs-zero')).toBeUndefined();
  });

  it.each([NaN, Infinity, -Infinity, -1, 0, 1, 2, 3.5, Number.MAX_SAFE_INTEGER + 1, '3', null])('rejects invalid keep %s at both public boundaries', async (keep) => {
    await expect(planPruneSnapshots('s', keep as number)).rejects.toThrow(/safe integer >= 3/);
    await expect(pruneSnapshots('s', keep as number, { dryRun: true })).rejects.toThrow(/safe integer >= 3/);
  });

  it.each(['.', '..', '../outside', 's/../../outside', 's\\outside', '', '\0'])('rejects unsafe source name %s', async (name) => {
    await expect(saveSnapshot(name, [])).rejects.toThrow(/Invalid snapshot source/);
    await expect(listSnapshotStubs(name)).rejects.toThrow(/Invalid snapshot source/);
    await expect(pruneSnapshots(name, 3)).rejects.toThrow(/Invalid snapshot source/);
  });

  it('supports dry-run planning and sorts same-second suffixes numerically', async () => {
    const when = new Date('2026-09-01T08:00:00Z');
    for (let n = 1; n <= 12; n++) await saveSnapshot('sort', [rec({ quantity: n })], when);
    const unknown = ['not-a-snapshot.jsonl', '2026-02-30T08-00-00.jsonl', '2026-09-01T08-00-00-01.jsonl'];
    for (const file of unknown) await writeFile(join(dir, 'sort', file), '{}');
    await mkdir(join(dir, 'sort', '2026-09-01T08-00-00-13.jsonl'));
    await symlink(join(dir, 'sort', unknown[0]!), join(dir, 'sort', '2026-09-01T08-00-00-14.jsonl'));
    const ids = Array.from({ length: 12 }, (_, n) => `2026-09-01T08-00-00${n ? `-${n + 1}` : ''}`);
    expect((await listSnapshotStubs('sort')).map((stub) => stub.id)).toEqual(ids);
    expect((await loadSnapshot('sort')).records[0]?.quantity).toBe(12);
    const plan = await planPruneSnapshots('sort', 3);
    expect(plan.toRemove.map((s) => s.id)).toEqual(ids.slice(0, 9));
    expect(plan.kept.map((s) => s.id)).toEqual(ids.slice(9));
    const dry = await pruneSnapshots('sort', 3, { dryRun: true });
    expect(dry).toEqual({ kept: 3, removed: 9, removedIds: ids.slice(0, 9) });
    expect(await listSnapshotStubs('sort')).toHaveLength(12);
    expect(await pruneSnapshots('sort', 3)).toEqual(dry);
    for (const file of unknown) expect(await readdir(join(dir, 'sort'))).toContain(file);
    expect(await readdir(join(dir, 'sort'))).toContain('2026-09-01T08-00-00-13.jsonl');
    expect(await readdir(join(dir, 'sort'))).toContain('2026-09-01T08-00-00-14.jsonl');
  });

  it('does not delete unknown files and reports non-ENOENT failures with partial progress', async () => {
    for (let i = 0; i < 6; i++) await saveSnapshot('errors', [], new Date(Date.UTC(2026, 8, 1, 8, 0, i)));
    const originalUnlink = fs.unlink;
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path).endsWith('08-00-01.jsonl')) throw denied;
      return originalUnlink(path);
    });
    const error = await pruneSnapshots('errors', 3).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SnapshotPruneError);
    expect(error).toMatchObject({
      failedId: '2026-09-01T08-00-01',
      cause: denied,
      result: { kept: 5, removed: 1, removedIds: ['2026-09-01T08-00-00'] },
    });
    expect((error as Error).message).toContain('already removed 1: 2026-09-01T08-00-00');
    expect(unlink).toHaveBeenCalledTimes(2);
    expect((await listSnapshotStubs('errors')).map((s) => s.id)).toEqual([
      '2026-09-01T08-00-01', '2026-09-01T08-00-02', '2026-09-01T08-00-03',
      '2026-09-01T08-00-04', '2026-09-01T08-00-05',
    ]);
  });

  it('prunes to the newest N snapshots and is idempotent', async () => {
    const mk = (n: number) => [rec({ source: 'p', sku: 'SKU-1', quantity: n })];
    for (let i = 0; i < 5; i++) {
      await saveSnapshot('p', mk(i), new Date(Date.UTC(2026, 8, 1, 8, 0, i))); // distinct ids, UTC
    }
    expect(await listSnapshots('p')).toHaveLength(5);

    const r = await pruneSnapshots('p', 3);
    expect(r.kept).toBe(3);
    expect(r.removed).toBe(2);

    const remaining = await listSnapshots('p');
    expect(remaining).toHaveLength(3);
    // The two OLDEST were removed; the newest three survive.
    expect(remaining.map((s) => s.id)).toEqual(['2026-09-01T08-00-02', '2026-09-01T08-00-03', '2026-09-01T08-00-04']);

    // Running again with the same keep count removes nothing.
    const again = await pruneSnapshots('p', 3);
    expect(again.removed).toBe(0);
  });
});
