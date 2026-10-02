import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InventoryRecord } from '../src/core/types.js';
import { listSnapshotStubs, listSnapshots, saveSnapshot } from '../src/snapshots.js';
import { runSnapshotCheck } from '../src/run.js';

// The window exists because retention and detection are different questions:
// a year of history is worth keeping, but loading all of it costs ~300 bytes
// per record — 365 daily snapshots of a 5,000-SKU shop would need ~510 MB.

let root = '';
const NAME = 'window-test';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'invdoc-window-'));
  process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] = root;
});

afterAll(async () => {
  delete process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'];
  await rm(root, { recursive: true, force: true });
});

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 9, 0, 0));

function rec(quantity: number): InventoryRecord {
  return {
    source: NAME,
    sku: 'SKU-1',
    barcode: null,
    title: null,
    location: null,
    quantity,
    quantityRaw: String(quantity),
    tracked: true,
    meta: {},
  };
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

async function seed(quantities: number[]): Promise<void> {
  for (const [index, quantity] of quantities.entries()) {
    await saveSnapshot(NAME, [rec(quantity)], day(index + 1));
  }
}

describe('snapshot window', () => {
  it('loads only the newest N snapshots and reports the total', async () => {
    await seed([5, 5, 5, 5, 5]);

    const result = await runSnapshotCheck(NAME, { maxSnapshots: 2 });

    expect(result.totalSnapshots).toBe(5);
    expect(result.snapshots).toHaveLength(2);
    expect(result.windowed).toBe(true);
  });

  it('is not windowed when the whole history fits', async () => {
    await seed([5, 5, 5]);

    const result = await runSnapshotCheck(NAME, { maxSnapshots: 10 });

    expect(result.windowed).toBe(false);
    expect(result.totalSnapshots).toBe(3);
    expect(result.snapshots).toHaveLength(3);
  });

  it('does not read snapshots outside the window', async () => {
    await seed([5, 5, 5, 0]);
    const stubs = await listSnapshotStubs(NAME);
    const oldest = stubs[0];
    const second = stubs[1];
    if (!oldest || !second) throw new Error('expected snapshots');
    await chmod(oldest.path, 0o000);
    await chmod(second.path, 0o000);

    // A windowed run succeeds because it never touches the unreadable files…
    const windowed = await runSnapshotCheck(NAME, { maxSnapshots: 2 });
    expect(windowed.snapshots).toHaveLength(2);

    // …while an unwindowed run has to read them and fails.
    await expect(runSnapshotCheck(NAME)).rejects.toThrow();

    await chmod(oldest.path, 0o600);
    await chmod(second.path, 0o600);
  });

  it('still detects a cliff inside the window', async () => {
    await seed([20, 20, 20, 0]);

    const result = await runSnapshotCheck(NAME, { maxSnapshots: 3 });

    expect(result.findings.some((f) => f.rule === 'nightly-zero' && f.severity === 'critical')).toBe(true);
  });

  it('lists stub metadata without reading file contents', async () => {
    await seed([5, 5]);
    const stubs = await listSnapshotStubs(NAME);
    const first = stubs[0];
    if (!first) throw new Error('expected a snapshot');
    await chmod(first.path, 0o000);

    // Listing stays cheap — it is readdir plus the timestamp encoded in the id.
    expect(await listSnapshotStubs(NAME)).toHaveLength(2);
    // Counting records cannot avoid reading the files.
    await expect(listSnapshots(NAME)).rejects.toThrow();

    await chmod(first.path, 0o600);
  });
});
