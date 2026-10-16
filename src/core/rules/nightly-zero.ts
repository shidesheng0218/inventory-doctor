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
        message: `"${rawSku}" had stock in ${stockedEarlier.length} consecutive snapshots but has no numeric quantity in the latest (${latest})`,
        detail: { sku: rawSku, latest, history },
        suggestion: 'Check whether the product/variant still exists, has a numeric quantity and is included in the export or sync scope.',
        evidence: [`Earlier quantities: ${history}.`, `No numeric quantity for this SKU at ${latest}.`],
        risk: 'If the SKU should remain within the same export scope, inventory visibility may be incomplete; absence or null quantity does not prove deletion or zero stock.',
        assumptions: ['Snapshots cover the same inventory and locations with comparable export scope.'],
        verification: ['Check product existence, tracking settings, export filters and snapshot completeness.'],
      });
      continue;
    }

    if (latestPoint.quantity === 0) {
      // Explicit zero in the latest snapshot after a stable positive history.
      // This heuristic selects a large change, not its business cause.
      const maxEarlier = Math.max(...stockedEarlier.map((e) => e.point?.quantity ?? 0));
      const stableBeforeCliff = lastStocked >= maxEarlier / 2;
      if (stableBeforeCliff) {
        findings.push({
          rule: 'nightly-zero',
          severity: 'critical',
          sku: rawSku,
          message: `"${rawSku}" was stocked across ${stockedEarlier.length} snapshots (last: ${lastStocked}) but reads 0 in the latest (${latest})`,
          detail: { sku: rawSku, latest, history, lastStocked },
          suggestion: 'Verify physical stock and reconcile sales, transfers, adjustments and sync/import logs between the snapshots before changing the zero.',
          evidence: [`Earlier quantities: ${history}.`, `Latest reported aggregate at ${latest}: 0.`],
          risk: 'If the zero is unintended, it may suppress availability or propagate through sync. Sales, transfers, adjustments or an import could also explain it; the cause is not established.',
          assumptions: ['Snapshots cover the same inventory and locations; aggregate zero does not establish every location is zero.'],
          verification: ['Check orders, transfers, reservations, adjustments, physical counts and sync/import logs over the actual snapshot interval.'],
        });
        continue;
      }
    }

    if (latestPoint.quantity > 0 && latestPoint.quantity * 2 <= lastStocked) {
      findings.push({
        rule: 'nightly-zero',
        severity: 'warning',
        sku: rawSku,
        message: `"${rawSku}" dropped from ${lastStocked} to ${latestPoint.quantity} between the last two snapshots`,
        detail: { sku: rawSku, latest, history, lastStocked, latestQuantity: latestPoint.quantity },
        suggestion: 'Reconcile the change with sales, transfers, reservations, adjustments and imports between these snapshots.',
        evidence: [`Earlier quantities: ${history}.`, `Latest reported aggregate at ${latest}: ${latestPoint.quantity}.`],
        risk: 'If unexplained by inventory activity, this reduction may indicate an incorrect adjustment; the size of the drop alone does not distinguish sales from a sync error.',
        assumptions: ['Snapshots cover the same inventory and locations with comparable quantity semantics.'],
        verification: ['Compare the interval with order, transfer, reservation, adjustment and import records.'],
      });
    }
  }

  return findings;
}
