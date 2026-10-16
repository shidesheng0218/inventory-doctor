import type { Finding, InventoryRecord } from '../types.js';
import { distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';
import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions } from '../types.js';

// R9 — compare listed bundle quantities with assemblies calculated from the
// supplied component quantities. Fulfillment and preassembled stock require
// separate verification.
//
// Evaluation is per (source, location): when a source has no location
// dimension, each SKU's cross-location sum is used. Component and bundle
// SKUs are matched canonically (case/whitespace-insensitive); reports show
// the SKU exactly as it appeared in the source.
export function bundleAvailability(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): Finding[] {
  const bundles = options.bundles ?? [];
  if (bundles.length === 0 || records.length === 0) return [];

  const bundleDefs = bundles.map((def) => ({ def, canonical: normalizeSku(def.sku).canonical }));
  const findings: Finding[] = [];

  for (const source of distinctSources(records)) {
    const sourceRecords = records.filter((r) => r.source === source);
    const hasLocation = sourceRecords.some((r) => r.location !== null && r.location.trim() !== '');
    // Per (source, location) buckets. A location-less source collapses into a
    // single bucket (the cross-location sum); a located source keeps
    // location-less rows in their own '(no location)' bucket.
    const buckets = new Map<string, { location: string | null; records: InventoryRecord[] }>();
    for (const r of sourceRecords) {
      const loc = r.location === null || r.location.trim() === '' ? null : r.location.trim();
      const key = hasLocation ? (loc ?? '(no location)') : '';
      const bucket = buckets.get(key) ?? { location: hasLocation ? loc : null, records: [] };
      bucket.records.push(r);
      buckets.set(key, bucket);
    }

    for (const { location, records: bucket } of buckets.values()) {
      // Incomplete numeric data is retained as unknown, never treated as
      // evidence that a component has zero stock.
      const qtyBySku = new Map<string, { qty: number; raw: string; unknown: boolean }>();
      for (const r of bucket) {
        if (r.sku === null) continue;
        const canonical = normalizeSku(r.sku).canonical;
        if (canonical === '') continue;
        const entry = qtyBySku.get(canonical) ?? { qty: 0, raw: r.sku, unknown: false };
        entry.qty += r.quantity ?? 0;
        entry.unknown ||= r.quantity === null;
        qtyBySku.set(canonical, entry);
      }

      for (const { def, canonical } of bundleDefs) {
        const listed = qtyBySku.get(canonical);
        if (!listed) continue; // bundle not listed in this source/location

        const missing: string[] = [];
        let computedMax = Infinity; // min over PRESENT components
        for (const component of def.components) {
          const componentEntry = qtyBySku.get(normalizeSku(component.sku).canonical);
          if (!componentEntry || componentEntry.unknown) {
            missing.push(component.sku);
            continue;
          }
          computedMax = Math.min(computedMax, Math.max(0, Math.floor(componentEntry.qty / component.quantity)));
        }

        const where = location !== null ? ` at location "${location}"` : '';
        const locDetail = location !== null ? { location } : {};

        if (missing.length > 0) {
          findings.push({
            rule: 'bundle-availability',
            severity: 'warning',
            sku: listed.raw,
            message: `"${listed.raw}" in ${source}${where} has missing or non-numeric component(s): ${missing.join(', ')} — bundle availability cannot be fully computed`,
            detail: { source, listed: listed.qty, missing, ...locDetail },
            suggestion:
              'Check component identifiers, export scope, tracking and quantity data; verify the kit definition before changing records.',
          });
        }

        if (computedMax === Infinity || missing.length > 0 || listed.unknown) continue; // no component present at all — the missing warning above carries it
        if (computedMax === 0 && listed.qty > 0) {
          findings.push({
            rule: 'bundle-availability',
            severity: options.allowBackorders ? 'warning' : 'critical',
            sku: listed.raw,
            message: `"${listed.raw}" is listed with quantity ${listed.qty} in ${source}${where} but the reported component quantities calculate to 0 assemblies`,
            detail: { source, listed: listed.qty, computedMax: 0, ...locDetail },
            suggestion: 'Check preassembled stock, component reservations, replenishment and backorder policy; adjust or pause the listing if immediate assembly is required.',
          });
          continue; // the critical carries the actionable message; no drift duplicate
        }

        const diff = Math.abs(listed.qty - computedMax);
        const base = Math.max(Math.abs(listed.qty), Math.abs(computedMax));
        const pct = base === 0 ? 0 : diff / base;
        if (diff > options.driftAbsThreshold || pct > options.driftPctThreshold) {
          findings.push({
            rule: 'bundle-availability',
            severity: 'warning',
            sku: listed.raw,
            message: `"${listed.raw}" listed quantity ${listed.qty} in ${source}${where} but the reported component quantities calculate to ${computedMax} assemblies`,
            detail: { source, listed: listed.qty, computedMax, diff, pct, ...locDetail },
            suggestion:
              'Verify kit definitions, preassembled stock, reservations and component availability before recomputing or changing the listing.',
          });
        }
      }
    }
  }

  return findings.map((f) => ({
    ...f,
    evidence: [f.message],
    risk: f.detail['missing'] !== undefined
      ? 'Missing or non-numeric component data prevents a complete assembly calculation; it does not establish that the component is out of stock.'
      : 'If fulfillment requires assembling the configured components from this inventory, listed availability may exceed assembly capacity. Preassembled stock, replenishment or backorders may explain the difference.',
    assumptions: ['Configured component quantities are correct and quantities describe usable stock at the same location.', 'Preassembled bundles, allocations and inbound replenishment are not represented in this calculation.', `Intentional backorders: ${options.allowBackorders === true}.`],
    verification: ['Check kit definitions, component stock, preassembled units, reservations and backorder commitments before changing availability.'],
  }));
}
