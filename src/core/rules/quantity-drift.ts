import type { Finding, HealthSummary, InventoryRecord } from '../types.js';
import {
  aggregateQuantity,
  groupByCanonicalSku,
  hasLocationDimension,
  perLocationQuantities,
  sourcePairs,
} from '../match.js';
import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions } from '../types.js';

// R5 — overall sync health: how many SKUs agree exactly, how many drift a
// little, how many are severely inconsistent, how many exist on one side only.
// When both sources carry locations, each compared unit is a (sku, location)
// pair; otherwise units are whole SKUs (one side's per-SKU quantity vs the
// other side's cross-location sum).
export function quantityDrift(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): Finding[] {
  const summary = computeHealthSummary(records, options);
  if (summary.totalCompared === 0) return [];

  const score = healthScore(summary);
  return [
    {
      rule: 'quantity-drift',
      severity: 'info',
      sku: null,
      message: `Sync health score: ${score}/100 — ${summary.matched} exact, ${summary.minorDrift} minor drift, ${summary.severeDrift} severe drift, ${summary.unmatched} unmatched of ${summary.totalCompared} SKUs compared`,
      detail: { ...summary, healthScore: score },
      suggestion:
        summary.severeDrift > 0 || summary.unmatched > 0
          ? 'Fix severe drift and orphan SKUs first; they are where oversells and lost sales live.'
          : 'Inventory is broadly in sync. Schedule regular diffs to keep it that way.',
    },
  ];
}

export function computeHealthSummary(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): HealthSummary {
  const summary: HealthSummary = { matched: 0, minorDrift: 0, severeDrift: 0, unmatched: 0, totalCompared: 0 };

  for (const [a, b] of sourcePairs(records)) {
    const mapA = groupByCanonicalSku(records, a);
    const mapB = groupByCanonicalSku(records, b);
    const seen = new Set<string>();

    for (const [canonical, bucketA] of mapA) {
      seen.add(canonical);
      const bucketB = mapB.get(canonical);
      if (!bucketB) {
        summary.unmatched += 1;
        continue;
      }

      if (hasLocationDimension(bucketA) && hasLocationDimension(bucketB)) {
        const locA = perLocationQuantities(bucketA);
        const locB = perLocationQuantities(bucketB);
        for (const [location, entryA] of locA) {
          const entryB = locB.get(location);
          if (!entryB) {
            summary.unmatched += 1; // location exists on one side only
            continue;
          }
          classifyUnit(summary, entryA.quantity, entryB.quantity, options);
        }
        for (const location of locB.keys()) {
          if (!locA.has(location)) summary.unmatched += 1;
        }
        continue;
      }

      classifyUnit(summary, aggregateQuantity(bucketA), aggregateQuantity(bucketB), options);
    }
    for (const canonical of mapB.keys()) {
      if (!seen.has(canonical)) summary.unmatched += 1;
    }
  }

  summary.totalCompared = summary.matched + summary.minorDrift + summary.severeDrift + summary.unmatched;
  return summary;
}

function classifyUnit(
  summary: HealthSummary,
  qtyA: number | null,
  qtyB: number | null,
  options: DiagnoseOptions,
): void {
  if (qtyA === null || qtyB === null) {
    // Blank on one side counts as severe inconsistency, not agreement.
    summary.severeDrift += 1;
    return;
  }
  const diff = Math.abs(qtyA - qtyB);
  if (diff === 0) {
    summary.matched += 1;
    return;
  }
  const base = Math.max(Math.abs(qtyA), Math.abs(qtyB));
  const pct = base === 0 ? 0 : diff / base;
  if (diff > options.driftAbsThreshold || pct > options.driftPctThreshold) {
    summary.severeDrift += 1;
  } else {
    summary.minorDrift += 1;
  }
}

export function healthScore(summary: HealthSummary): number {
  if (summary.totalCompared === 0) return 100;
  const raw = (summary.matched + summary.minorDrift * 0.5) / summary.totalCompared;
  return Math.round(raw * 100);
}
