import { canonicalSku } from './core/normalize.js';
import { loadSnapshotWindow } from './snapshots.js';

// Per-SKU time-series across the saved snapshots of one source. This is the
// conversational follow-up tool: when a diff or a time-series check flags a
// SKU, the agent can ask "show me this SKU's history" and see exactly when the
// quantity moved — including the difference between "went to 0" and "cell
// went blank", which is the classic silent-oversell signature.

export interface SkuHistoryPoint {
  snapshotId: string;
  savedAt: string;
  location: string | null;
  quantity: number | null; // null !== 0: blank cell, kept first-class
}

export interface SkuHistory {
  sku: string; // the SKU as the caller asked for it
  canonical: string; // normalized form the matching used
  found: boolean; // false → points is empty (agent-friendly, never throws)
  points: SkuHistoryPoint[]; // expanded per (snapshotId, location)
}

export async function skuHistory(sku: string, name: string, options: { maxSnapshots?: number } = {}): Promise<SkuHistory> {
  const canonical = canonicalSku(sku);
  const snapshots = await loadSnapshotWindow(name, options.maxSnapshots);
  const points: SkuHistoryPoint[] = [];
  for (const snapshot of snapshots) {
    for (const record of snapshot.records) {
      if (record.sku === null) continue;
      if (canonicalSku(record.sku) !== canonical) continue;
      points.push({
        snapshotId: snapshot.id,
        savedAt: snapshot.savedAt,
        location: record.location,
        quantity: record.quantity,
      });
    }
  }
  return { sku, canonical, found: points.length > 0, points };
}
