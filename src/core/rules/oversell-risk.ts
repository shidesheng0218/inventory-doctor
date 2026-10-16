import type { Finding, InventoryRecord } from '../types.js';
import {
  aggregateQuantity,
  groupByCanonicalSku,
  hasLocationDimension,
  perLocationQuantities,
  sourcePairs,
  type SkuBucket,
} from '../match.js';
import { normalizeSku } from '../normalize.js';
import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions } from '../types.js';

// R2 — observed quantities/policies with conditional availability risk:
//   quantity <= 0 in one source but > 0 in another;
//   "continue selling when out of stock" with quantity <= 0;
//   cross-source quantity drift beyond the configured threshold.
//
// Comparison is location-aligned: when BOTH sources carry a location
// dimension, quantities are compared per (sku, location) — a location-level
// difference must surface and must not be hidden by summing across locations.
// When one side has no location dimension, its per-SKU quantity is compared
// against the other side's cross-location sum.
export function oversellRisk(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): Finding[] {
  const findings: Finding[] = [];
  const pairs = sourcePairs(records);

  // Continue-selling policy (Shopify "Continue selling when out of stock").
  // This needs no second source — it is true of one store right now — so it is
  // checked once per (source, sku, location) instead of only for SKUs present in BOTH
  // sources (and once per matched pair, which a three-source diff duplicated).
  // Collected separately and appended after the comparisons so the report's
  // ordering within a severity does not shift for existing users.
  const policyFindings: Finding[] = [];
  const policySeen = new Set<string>();
  for (const r of records) {
    if (r.meta['inventoryPolicy'] !== 'continue') continue;
    if (r.quantity === null || r.quantity > 0) continue;
    if (r.sku === null) continue;
    const key = r.source + '\u0000' + normalizeSku(r.sku).canonical + '\u0000' + (r.location ?? '');
    if (policySeen.has(key)) continue;
    policySeen.add(key);

    policyFindings.push({
      rule: 'oversell-risk',
      severity: options.allowBackorders ? 'info' : 'warning',
      sku: r.sku,
      message: `"${r.sku}" in ${r.source} has policy ("continue selling when out of stock") with quantity ${r.quantity}`,
      detail: { source: r.source, location: r.location, quantity: r.quantity, inventoryPolicy: 'continue' },
      suggestion: 'Confirm the continue-selling policy and intended backorder lead times; check whether orders can actually be placed and fulfilled.',
      evidence: [`${r.source}: quantity ${r.quantity}; inventoryPolicy=continue.`],
      risk: 'If checkout honors this policy, orders may be accepted despite non-positive reported stock; fulfillment depends on replenishment and backorder arrangements.',
      assumptions: [`Intentional backorders: ${options.allowBackorders === true}.`],
      verification: ['Check checkout availability, reservations, replenishment dates and backorder commitments.'],
    });
  }

  for (const [a, b] of options.inventoryRelationship === 'independent' ? [] : pairs) {
    const mapA = groupByCanonicalSku(records, a);
    const mapB = groupByCanonicalSku(records, b);

    for (const [canonical, bucketA] of mapA) {
      const bucketB = mapB.get(canonical);
      if (!bucketB) continue; // orphans are R1's job
      const rawSku = bucketA.records[0]?.sku ?? canonical;

      if (hasLocationDimension(bucketA) && hasLocationDimension(bucketB)) {
        compareByLocation(findings, rawSku, a, bucketA, b, bucketB, options);
      } else {
        compareAggregate(findings, rawSku, a, aggregateQuantity(bucketA), b, aggregateQuantity(bucketB), options, null);
      }
    }
  }

  findings.push(...policyFindings);

  return findings.map((f) => ({
    ...f,
    evidence: f.evidence ?? [f.message],
    risk: f.risk ?? 'If the sources describe the same stock pool and higher reported stock is offered for sale, availability may be overstated. A discrepancy alone does not prove overselling.',
    assumptions: f.assumptions ?? [`Inventory relationship: ${options.inventoryRelationship ?? 'unknown'}.`, `Intentional backorders: ${options.allowBackorders === true}.`, 'SKU identity, quantity semantics, locations and capture times are comparable.'],
    verification: f.verification ?? ['Confirm the stock pool relationship and system of record; check physical stock, reservations, pending orders and snapshot times.'],
  }));
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
      severity: options.inventoryRelationship === 'shared' && !options.allowBackorders ? 'critical' : 'warning',
      sku: rawSku,
      message: `"${rawSku}" reports non-positive quantity in ${empty.source} (${empty.qty})${where} and ${stocked.qty} in ${stocked.source}`,
      detail: { sourceA: a, sourceB: b, quantityA: qtyA, quantityB: qtyB, ...locDetail },
      suggestion: 'Confirm whether the sources share a stock pool, then verify physical stock, reservations and the authoritative system before reconciling either source.',
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
      severity: options.inventoryRelationship === 'shared' && !options.allowBackorders ? (severe ? 'critical' : 'warning') : 'warning',
      sku: rawSku,
      message: `"${rawSku}" quantity differs by ${diff} (${Math.round(pct * 100)}%)${where}: ${qtyA} in ${a} vs ${qtyB} in ${b}`,
      detail: { sourceA: a, sourceB: b, quantityA: qtyA, quantityB: qtyB, diff, pct, ...locDetail },
      suggestion: 'Confirm the inventory relationship, capture times and quantity semantics; identify the authoritative system before reconciling counts.',
    });
  }
}
