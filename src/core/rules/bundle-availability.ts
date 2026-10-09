import type { Finding, InventoryRecord } from '../types.js';
import { distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';
import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions } from '../types.js';

// R9 — bundle (kit) availability:
//   a bundle listed as sellable while its components can no longer support
//   even one assembly (critical: orders will be accepted and fail);
//   listed bundle quantity drifting from what component stock actually
//   supports (warning); a component missing entirely from a source
//   (warning — availability cannot be fully computed).
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
      // Canonical SKU → aggregate quantity (sum of non-null; a blank cell
      // counts as 0 here — blank-vs-zero reports it separately) + raw SKU
      // for display.
      const qtyBySku = new Map<string, { qty: number; raw: string }>();
      for (const r of bucket) {
        if (r.sku === null) continue;
        const canonical = normalizeSku(r.sku).canonical;
        if (canonical === '') continue;
        const entry = qtyBySku.get(canonical) ?? { qty: 0, raw: r.sku };
        entry.qty += r.quantity ?? 0;
        qtyBySku.set(canonical, entry);
      }

      for (const { def, canonical } of bundleDefs) {
        const listed = qtyBySku.get(canonical);
        if (!listed) continue; // bundle not listed in this source/location

        const missing: string[] = [];
        let computedMax = Infinity; // min over PRESENT components
        for (const component of def.components) {
          const componentEntry = qtyBySku.get(normalizeSku(component.sku).canonical);
          if (!componentEntry) {
            missing.push(component.sku);
            continue;
          }
          computedMax = Math.min(computedMax, Math.floor(componentEntry.qty / component.quantity));
        }

        const where = location !== null ? ` at location "${location}"` : '';
        const locDetail = location !== null ? { location } : {};

        if (missing.length > 0) {
          findings.push({
            rule: 'bundle-availability',
            severity: 'warning',
            sku: listed.raw,
            message: `"${listed.raw}" in ${source}${where} is missing component(s): ${missing.join(', ')} — bundle availability cannot be fully computed`,
            detail: { source, listed: listed.qty, missing, ...locDetail },
            suggestion:
              'Add the missing component SKU(s) to this source, or fix the bundle definition if the component was renamed.',
          });
        }

        if (computedMax === Infinity) continue; // no component present at all — the missing warning above carries it
        if (computedMax === 0 && listed.qty > 0) {
          findings.push({
            rule: 'bundle-availability',
            severity: 'critical',
            sku: listed.raw,
            message: `"${listed.raw}" is listed with quantity ${listed.qty} in ${source}${where} but its components can support 0 bundles — new orders cannot be fulfilled`,
            detail: { source, listed: listed.qty, computedMax: 0, ...locDetail },
            suggestion: 'Pause the bundle listing or restock its components before more orders come in.',
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
            message: `"${listed.raw}" listed quantity ${listed.qty} in ${source}${where} but component stock supports ${computedMax}`,
            detail: { source, listed: listed.qty, computedMax, diff, pct, ...locDetail },
            suggestion:
              'Recompute the bundle quantity from component stock and correct the listing, or investigate orders/restocks that consumed components without decrementing the bundle.',
          });
        }
      }
    }
  }

  return findings;
}
