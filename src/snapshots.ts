import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
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
  // Returned diagnostics, never stdout. Also copied to affected rows' meta.
  warnings: string[];
}

// Cheapest possible view of a history: directory listing only. Counting
// records means reading every file, which is O(history) I/O — fine for one
// snapshot, ruinous when a year of daily snapshots is involved. Callers that
// only need ids/timestamps (choosing a window, trimming) use this.
export interface SnapshotStub {
  id: string;
  path: string;
  savedAt: string;
}

export function snapshotRoot(): string {
  return process.env['INVENTORY_DOCTOR_SNAPSHOT_DIR'] ?? join(homedir(), '.local', 'share', 'inventory-doctor', 'snapshots');
}

function dirFor(sourceName: string): string {
  if (!sourceName.trim() || sourceName === '.' || sourceName === '..' || /[/\\\0]/.test(sourceName)) {
    throw new Error(`Invalid snapshot source name: ${JSON.stringify(sourceName)}`);
  }
  const safe = sourceName.replace(/[^\w.-]+/g, '_');
  return join(snapshotRoot(), safe);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function idFromDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

export async function saveSnapshot(sourceName: string, records: InventoryRecord[], now: Date = new Date()): Promise<SnapshotInfo> {
  const dir = dirFor(sourceName);
  const normalized = records.map((record, i) => {
    const row = normalizeRecord(record, `${sourceName} (record ${i + 1})`, sourceName);
    return { ...row, meta: { ...row.meta, snapshotVersion: '1', snapshotSource: row.meta['snapshotSource'] ?? row.source } };
  });
  await mkdir(dir, { recursive: true });
  // Never overwrite an existing snapshot: two saves landing in the same second
  // would otherwise silently destroy history. Suffixed ids keep both.
  let id = idFromDate(now);
  let path = join(dir, `${id}.jsonl`);
  for (let n = 2; existsSync(path); n += 1) {
    id = `${idFromDate(now)}-${n}`;
    path = join(dir, `${id}.jsonl`);
  }
  const body = normalized.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(path, body, 'utf8');
  return { id, path, savedAt: now.toISOString(), recordCount: records.length };
}

export async function listSnapshotStubs(sourceName: string): Promise<SnapshotStub[]> {
  const dir = dirFor(sourceName);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => ({ id: entry.name.slice(0, -6), path: join(dir, entry.name) }))
    .filter((entry) => parseSnapshotId(entry.id) !== null)
    .sort((a, b) => {
      const left = parseSnapshotId(a.id)!;
      const right = parseSnapshotId(b.id)!;
      return left.time - right.time || left.sequence - right.sequence;
    })
    .map((entry) => ({ ...entry, savedAt: savedAtFromId(entry.id) }));
}

export async function listSnapshots(sourceName: string): Promise<SnapshotInfo[]> {
  const stubs = await listSnapshotStubs(sourceName);
  const infos: SnapshotInfo[] = [];
  for (const stub of stubs) {
    const { id, path } = stub;
    const content = await readFile(path, 'utf8');
    const recordCount = content.split('\n').filter((line) => line.trim() !== '').length;
    infos.push({ id, path, savedAt: savedAtFromId(id), recordCount });
  }
  return infos;
}

export interface PruneResult {
  kept: number;
  removed: number;
  removedIds: string[];
}

export interface PrunePlan {
  keep: number;
  kept: SnapshotStub[];
  toRemove: SnapshotStub[];
}

export interface PruneOptions {
  // Returns the planned counts/ids without deleting anything.
  dryRun?: boolean;
}

export class SnapshotPruneError extends Error {
  constructor(public readonly failedId: string, public readonly result: PruneResult, cause: unknown) {
    super(`Failed to prune snapshot ${failedId}; already removed ${result.removed}: ${result.removedIds.join(', ') || '(none)'}`, { cause });
    this.name = 'SnapshotPruneError';
  }
}

export async function planPruneSnapshots(sourceName: string, keep = 30): Promise<PrunePlan> {
  if (!Number.isSafeInteger(keep) || keep < 3) {
    throw new RangeError('Snapshot keep must be a safe integer >= 3');
  }
  const stubs = await listSnapshotStubs(sourceName);
  const split = Math.max(0, stubs.length - keep);
  return { keep, kept: stubs.slice(split), toRemove: stubs.slice(0, split) };
}

// Directory-only planning; unknown files, directories and symlinks are never
// candidates. A failed deletion stops immediately and exposes partial progress.
export async function pruneSnapshots(sourceName: string, keep = 30, options: PruneOptions = {}): Promise<PruneResult> {
  const plan = await planPruneSnapshots(sourceName, keep);
  if (options.dryRun) {
    return { kept: plan.kept.length, removed: plan.toRemove.length, removedIds: plan.toRemove.map((stub) => stub.id) };
  }
  const total = plan.kept.length + plan.toRemove.length;
  const removedIds: string[] = [];
  let vanished = 0;
  for (const stub of plan.toRemove) {
    try {
      await unlink(stub.path);
      removedIds.push(stub.id);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        vanished += 1;
        continue;
      }
      throw new SnapshotPruneError(stub.id, {
        kept: total - removedIds.length - vanished, removed: removedIds.length, removedIds: [...removedIds],
      }, error);
    }
  }
  return { kept: total - removedIds.length - vanished, removed: removedIds.length, removedIds };
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

  // Stubs, not listSnapshots: resolving a reference must not read (and count)
  // every file in the history. This runs once per loaded snapshot, so counting
  // here would make a windowed check do O(history) I/O N times over.
  const all = await listSnapshotStubs(name);
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

// The newest N snapshots of a source, fully loaded. Listing stays cheap; only
// the files inside the window are read. maxSnapshots (when a finite positive
// number) keeps long histories flat in memory. Throws the same guidance as
// loadSnapshot when nothing is saved yet.
export async function loadSnapshotWindow(name: string, maxSnapshots?: number): Promise<LoadedSnapshot[]> {
  const stubs = await listSnapshotStubs(name);
  if (stubs.length === 0) {
    throw new Error(`No snapshots for "${name}". Save one first: inventory-doctor snapshot save <source>`);
  }
  const max =
    typeof maxSnapshots === 'number' && Number.isFinite(maxSnapshots) && maxSnapshots > 0
      ? Math.floor(maxSnapshots)
      : undefined;
  const window = max !== undefined && stubs.length > max ? stubs.slice(-max) : stubs;
  return Promise.all(window.map((s) => readSnapshot(name, s.id, s.path)));
}

async function readSnapshot(name: string, id: string, path: string): Promise<LoadedSnapshot> {
  const content = await readFile(path, 'utf8');
  const savedAt = savedAtFromId(id);
  const records: InventoryRecord[] = [];
  const warnings: string[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `Corrupt snapshot file ${path} (line ${i + 1}): invalid JSON. Delete the file or re-save the snapshot.`,
      );
    }
    const record = normalizeRecord(parsed, `${path} (line ${i + 1})`, name, warnings);
    // Re-tag so reports show which snapshot a row came from, and so
    // time-aware rules (nightly-zero) can order snapshots chronologically.
    record.meta = { ...record.meta, snapshotAt: savedAt, snapshotSource: record.meta['snapshotSource'] ?? record.source, snapshotVersion: record.meta['snapshotVersion'] ?? '0' };
    record.source = `${name}@${id}`;
    records.push(record);
  }
  return { name, id, path, savedAt, recordCount: records.length, records, warnings };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// JSON is an untyped boundary. Missing legacy fields become explicit unknowns;
// malformed fields fail here rather than surfacing as NaN or a rule's .trim crash.
function normalizeRecord(value: unknown, context: string, fallbackSource: string, warnings?: string[]): InventoryRecord {
  const invalid = (field: string): never => {
    throw new Error(`Corrupt snapshot record ${context}: invalid ${field}. Re-save the snapshot.`);
  };
  if (!isObject(value)) return invalid('record (expected an object)');
  const nullableString = (field: string): string | null => {
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null) return null;
    return typeof fieldValue === 'string' ? fieldValue : invalid(field);
  };
  const nullableBoolean = (field: string): boolean | null => {
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null) return null;
    return typeof fieldValue === 'boolean' ? fieldValue : invalid(field);
  };
  const quantity = value['quantity'] ?? null;
  if (quantity !== null && (typeof quantity !== 'number' || !Number.isSafeInteger(quantity))) {
    return invalid('quantity (expected a safe integer or null)');
  }
  const source = value['source'] === undefined ? fallbackSource : nullableString('source');
  if (source === null || !source.trim()) return invalid('source');
  const quantityRaw = value['quantityRaw'] === undefined
    ? (quantity === null ? '' : String(quantity))
    : nullableString('quantityRaw');
  if (quantityRaw === null) return invalid('quantityRaw');
  const meta: Record<string, string> = {};
  if (value['meta'] !== undefined) {
    if (!isObject(value['meta'])) return invalid('meta');
    for (const [key, entry] of Object.entries(value['meta'])) {
      if (typeof entry !== 'string') return invalid(`meta.${key}`);
      Object.defineProperty(meta, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
  }
  const cellIsBlank = nullableBoolean('cellIsBlank');
  if (value['cellIsBlank'] === undefined || (warnings !== undefined && meta['snapshotVersion'] === undefined)) {
    const message = `Legacy snapshot record ${context}: unknown source/version or blank-cell provenance; missing cellIsBlank is treated as null, never inferred from quantityRaw.`;
    warnings?.push(message);
    meta['snapshotWarning'] = message;
  } else if (meta['snapshotWarning']) {
    warnings?.push(meta['snapshotWarning']);
  }
  return {
    source, sku: nullableString('sku'), barcode: nullableString('barcode'),
    title: nullableString('title'), location: nullableString('location'),
    quantity, quantityRaw, cellIsBlank, tracked: nullableBoolean('tracked'), meta,
  };
}

function parseSnapshotId(id: string): { savedAt: string; time: number; sequence: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-([1-9]\d*))?$/.exec(id);
  if (!match) return null;
  const savedAt = `${match[1]}:${match[2]}:${match[3]}`;
  const time = Date.parse(`${savedAt}Z`);
  const sequence = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== savedAt
    || !Number.isSafeInteger(sequence) || (match[4] !== undefined && sequence < 2)) return null;
  return { savedAt, time, sequence };
}

function savedAtFromId(id: string): string {
  return parseSnapshotId(id)?.savedAt ?? id;
}
