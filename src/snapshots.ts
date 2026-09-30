import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InventoryRecord } from './core/types.js';

// Snapshot history: each save appends one JSONL file (one InventoryRecord per
// line) under <root>/<sourceName>/<id>.jsonl. Everything stays on the local
// disk — same privacy posture as the rest of the tool.

export interface SnapshotInfo {
  id: string; // filesystem-safe ISO timestamp, e.g. "2026-09-05T14-30-00"
  path: string;
  savedAt: string; // ISO timestamp
  recordCount: number;
}

export interface LoadedSnapshot extends SnapshotInfo {
  name: string;
  records: InventoryRecord[];
}

export function snapshotRoot(): string {
  return process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] ?? join(homedir(), '.local', 'share', 'inventory-doctor', 'snapshots');
}

function dirFor(sourceName: string): string {
  const safe = sourceName.replace(/[^\w.-]+/g, '_');
  return join(snapshotRoot(), safe);
}

function idFromDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

export async function saveSnapshot(sourceName: string, records: InventoryRecord[], now: Date = new Date()): Promise<SnapshotInfo> {
  const dir = dirFor(sourceName);
  await mkdir(dir, { recursive: true });
  // Never overwrite an existing snapshot: two saves landing in the same second
  // would otherwise silently destroy history. Suffixed ids keep both.
  let id = idFromDate(now);
  let path = join(dir, `${id}.jsonl`);
  for (let n = 2; existsSync(path); n += 1) {
    id = `${idFromDate(now)}-${n}`;
    path = join(dir, `${id}.jsonl`);
  }
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(path, body, 'utf8');
  return { id, path, savedAt: now.toISOString(), recordCount: records.length };
}

export async function listSnapshots(sourceName: string): Promise<SnapshotInfo[]> {
  const dir = dirFor(sourceName);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const infos: SnapshotInfo[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.jsonl'.length);
    const path = join(dir, file);
    const content = await readFile(path, 'utf8');
    const recordCount = content.split('\n').filter((line) => line.trim() !== '').length;
    infos.push({ id, path, savedAt: savedAtFromId(id), recordCount });
  }
  return infos;
}

// ref resolution: a file path, "<name>@<id-prefix>", or "<name>" (latest).
export async function loadSnapshot(ref: string): Promise<LoadedSnapshot> {
  if (existsSync(ref) && !ref.includes('@')) {
    const file = ref.replace(/\\/g, '/').split('/').pop() ?? ref;
    const name = ref.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? 'snapshot';
    const id = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : file;
    return readSnapshot(name, id, ref);
  }

  const at = ref.indexOf('@');
  const name = at === -1 ? ref : ref.slice(0, at);
  const idPrefix = at === -1 ? null : ref.slice(at + 1);
  if (name === '') throw new Error('Invalid snapshot reference. Use "<name>", "<name>@<id>", or a file path.');

  const all = await listSnapshots(name);
  if (all.length === 0) {
    throw new Error(`No snapshots for "${name}". Save one first: inventory-doctor snapshot save <source>`);
  }
  // An exact id wins over prefix matching — collision-suffixed ids
  // ("...-2") sort BEFORE their unsuffixed sibling lexically.
  const match =
    idPrefix === null
      ? all[all.length - 1]
      : (all.find((s) => s.id === idPrefix) ?? all.find((s) => s.id.startsWith(idPrefix)));
  if (!match) {
    throw new Error(
      `No snapshot "${idPrefix}" for "${name}". Available: ${all.map((s) => s.id).join(', ')}`,
    );
  }
  return readSnapshot(name, match.id, match.path);
}

async function readSnapshot(name: string, id: string, path: string): Promise<LoadedSnapshot> {
  const content = await readFile(path, 'utf8');
  const savedAt = savedAtFromId(id);
  const records: InventoryRecord[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let record: InventoryRecord;
    try {
      record = JSON.parse(line) as InventoryRecord;
    } catch {
      throw new Error(
        `Corrupt snapshot file ${path} (line ${i + 1}): invalid JSON. Delete the file or re-save the snapshot.`,
      );
    }
    // Re-tag so reports show which snapshot a row came from, and so
    // time-aware rules (nightly-zero) can order snapshots chronologically.
    record.source = `${name}@${id}`;
    record.meta = { ...record.meta, snapshotAt: savedAt };
    records.push(record);
  }
  return { name, id, path, savedAt, recordCount: records.length, records };
}

function savedAtFromId(id: string): string {
  // id "2026-09-05T14-30-00" → ISO "2026-09-05T14:30:00"; a collision suffix
  // ("...-2") is ignored so ordering keys stay comparable across ids.
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/.exec(id);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : id;
}
