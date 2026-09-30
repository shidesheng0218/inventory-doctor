import type { Finding, InventoryRecord } from '../types.js';
import { normalizeSku } from '../normalize.js';

// R7 — time-series detection across saved snapshots: the "silently zeroed
// overnight" pattern that a single snapshot-vs-snapshot diff cannot see. A
// SKU that held stock across at least two earlier snapshots and is suddenly
// at an explicit 0 in the latest one did not necessarily sell through —
// something may have wiped it.
//
// Only records tagged by snapshot loading (meta.snapshotAt) participate; on a
// plain two-source diff this rule returns nothing. At least three snapshots
// are required so one prior data point is never mistaken for "history".
export function nightlyZero(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];

  const timestamps = [
    ...new Set(records.map((r) => r.meta['snapshotAt']).filter((t): t is string => t !== undefined)),
  ].sort();
  if (timestamps.length < 3) return findings;
  const latest = timestamps[timestamps.length - 1] as string;
  const earlier = timestamps.slice(0, -1);

  interface SeriesPoint {
    quantity: number | null; // null = SKU absent or every cell blank in that snapshot
    rawSku: string | null;
  }
  const series = new Map<string, Map<string, SeriesPoint>>(); // canonical → snapshotAt → point

  for (const r of records) {
    const at = r.meta['snapshotAt'];
    if (at === undefined) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;
    const byAt = series.get(canonical) ?? new Map<string, SeriesPoint>();
    const point = byAt.get(at) ?? { quantity: null, rawSku: r.sku };
    if (r.quantity !== null) point.quantity = (point.quantity ?? 0) + r.quantity;
    byAt.set(at, point);
    series.set(canonical, byAt);
  }

  for (const [canonical, byAt] of series) {
    const latestPoint = byAt.get(latest);
    const earlierPoints = earlier.map((at) => ({ at, point: byAt.get(at) }));
    const rawSku =
      latestPoint?.rawSku ?? earlierPoints.find((e) => e.point?.rawSku != null)?.point?.rawSku ?? canonical;

    // Need a positive stock level in every earlier snapshot to claim "stable".
    const stockedEarlier = earlierPoints.filter((e) => e.point !== undefined && e.point.quantity !== null && e.point.quantity > 0);
    if (stockedEarlier.length < earlier.length || stockedEarlier.length < 2) continue;
    const lastStocked = stockedEarlier[stockedEarlier.length - 1]?.point?.quantity ?? 0;
    const history = earlierPoints.map((e) => `${e.at}: ${e.point?.quantity ?? '—'}`).join(', ');

    if (latestPoint === undefined || latestPoint.quantity === null) {
      findings.push({
        rule: 'nightly-zero',
        severity: 'warning',
        sku: rawSku,
        message: `"${rawSku}" had stock in ${stockedEarlier.length} consecutive snapshots but is missing from the latest (${latest}) — the listing may have been deleted or the export dropped it`,
        detail: { sku: rawSku, latest, history },
        suggestion: 'Check whether the product/variant still exists and is included in the export or sync scope.',
      });
      continue;
    }

    if (latestPoint.quantity === 0) {
      // Explicit zero in the latest snapshot after a stable positive history.
      // A gradual sell-through shows a declining trend first; a cliff does not.
      const maxEarlier = Math.max(...stockedEarlier.map((e) => e.point?.quantity ?? 0));
      const stableBeforeCliff = lastStocked >= maxEarlier / 2;
      if (stableBeforeCliff) {
        findings.push({
          rule: 'nightly-zero',
          severity: 'critical',
          sku: rawSku,
          message: `"${rawSku}" was stocked across ${stockedEarlier.length} snapshots (last: ${lastStocked}) but reads 0 in the latest (${latest}) — the classic "silently zeroed overnight" pattern`,
          detail: { sku: rawSku, latest, history, lastStocked },
          suggestion: 'Verify against the warehouse/system of record before trusting the zero; check recent bulk imports and sync-app runs from the past day.',
        });
        continue;
      }
    }

    if (latestPoint.quantity > 0 && latestPoint.quantity * 2 <= lastStocked) {
      findings.push({
        rule: 'nightly-zero',
        severity: 'warning',
        sku: rawSku,
        message: `"${rawSku}" dropped from ${lastStocked} to ${latestPoint.quantity} between the last two snapshots — a sharper fall than normal sell-through usually looks like`,
        detail: { sku: rawSku, latest, history, lastStocked, latestQuantity: latestPoint.quantity },
        suggestion: 'Confirm the drop matches actual sales; if not, look for a sync or import that halved the count.',
      });
    }
  }

  return findings;
}
