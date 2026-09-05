import type { Finding, InventoryRecord } from '../types.js';
import {
  aggregateQuantity,
  groupByCanonicalSku,
  hasLocationDimension,
  perLocationQuantities,
  sourcePairs,
  type SkuBucket,
} from '../match.js';
import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions } from '../types.js';

// R2 — SKUs you may be overselling right now:
//   quantity <= 0 in one source but > 0 in another;
//   "continue selling when out of stock" with quantity <= 0;
//   cross-source quantity drift beyond the configured threshold.
//
// Comparison is location-aligned: when BOTH sources carry a location
// dimension, quantities are compared per (sku, location) — a location-level
// oversell must surface and must not be hidden by summing across locations.
// When one side has no location dimension, its per-SKU quantity is compared
// against the other side's cross-location sum.
export function oversellRisk(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): Finding[] {
  const findings: Finding[] = [];

  for (const [a, b] of sourcePairs(records)) {
    const mapA = groupByCanonicalSku(records, a);
    const mapB = groupByCanonicalSku(records, b);

    for (const [canonical, bucketA] of mapA) {
      const bucketB = mapB.get(canonical);
      if (!bucketB) continue; // orphans are R1's job
      const rawSku = bucketA.records[0]?.sku ?? canonical;

      // Continue-selling policy (Shopify "Continue selling when out of stock").
      for (const bucket of [bucketA, bucketB]) {
        for (const r of bucket.records) {
          const policy = r.meta['inventoryPolicy'];
          const qty = r.quantity;
          if (policy === 'continue' && qty !== null && qty <= 0) {
            findings.push({
              rule: 'oversell-risk',
              severity: 'warning',
              sku: r.sku,
              message: `"${r.sku ?? canonical}" in ${r.source} allows overselling ("continue selling when out of stock") with quantity ${qty}`,
              detail: { source: r.source, location: r.location, quantity: qty, inventoryPolicy: policy },
              suggestion: 'Confirm this oversell setting is intentional, and make sure the other source does not also count this stock.',
            });
          }
        }
      }

      if (hasLocationDimension(bucketA) && hasLocationDimension(bucketB)) {
        compareByLocation(findings, rawSku, a, bucketA, b, bucketB, options);
      } else {
        compareAggregate(findings, rawSku, a, aggregateQuantity(bucketA), b, aggregateQuantity(bucketB), options, null);
      }
    }
  }

  return findings;
}

function compareByLocation(
  findings: Finding[],
  rawSku: string,
  a: string,
  bucketA: SkuBucket,
  b: string,
  bucketB: SkuBucket,
  options: DiagnoseOptions,
): void {
  const locA = perLocationQuantities(bucketA);
  const locB = perLocationQuantities(bucketB);
  for (const [location, entryA] of locA) {
    const entryB = locB.get(location);
    if (!entryB) continue; // location exists on one side only — nothing to compare against
    compareAggregate(findings, rawSku, a, entryA.quantity, b, entryB.quantity, options, location);
  }
}

function compareAggregate(
  findings: Finding[],
  rawSku: string,
  a: string,
  qtyA: number | null,
  b: string,
  qtyB: number | null,
  options: DiagnoseOptions,
  location: string | null,
): void {
  if (qtyA === null || qtyB === null) return; // blanks are R3's job
  const where = location !== null ? ` at location "${location}"` : '';
  const locDetail = location !== null ? { location } : {};

  if ((qtyA <= 0 && qtyB > 0) || (qtyB <= 0 && qtyA > 0)) {
    const empty = qtyA <= 0 ? { source: a, qty: qtyA } : { source: b, qty: qtyB };
    const stocked = qtyA <= 0 ? { source: b, qty: qtyB } : { source: a, qty: qtyA };
    findings.push({
      rule: 'oversell-risk',
      severity: 'critical',
      sku: rawSku,
      message: `"${rawSku}" is out of stock in ${empty.source} (${empty.qty})${where} but shows ${stocked.qty} available in ${stocked.source} — you may be selling stock you don't have`,
      detail: { sourceA: a, sourceB: b, quantityA: qtyA, quantityB: qtyB, ...locDetail },
      suggestion: `Push the real quantity from ${stocked.source} to ${empty.source}, or pause the listing in ${empty.source}.`,
    });
    return; // the critical above carries the actionable message; no drift duplicate
  }

  const diff = Math.abs(qtyA - qtyB);
  const base = Math.max(Math.abs(qtyA), Math.abs(qtyB));
  const pct = base === 0 ? 0 : diff / base;
  if (diff > options.driftAbsThreshold || pct > options.driftPctThreshold) {
    const severe = diff >= options.driftAbsThreshold * 2 || pct >= options.driftPctThreshold * 2;
    findings.push({
      rule: 'oversell-risk',
      severity: severe ? 'critical' : 'warning',
      sku: rawSku,
      message: `"${rawSku}" quantity differs by ${diff} (${Math.round(pct * 100)}%)${where}: ${qtyA} in ${a} vs ${qtyB} in ${b}`,
      detail: { sourceA: a, sourceB: b, quantityA: qtyA, quantityB: qtyB, diff, pct, ...locDetail },
      suggestion: 'Reconcile the count in the source of truth and re-sync; investigate recent orders/restocks that only one side recorded.',
    });
  }
}
