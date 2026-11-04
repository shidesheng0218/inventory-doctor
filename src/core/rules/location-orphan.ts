import type { Finding, InventoryRecord } from '../types.js';
import { hasLocationDimension, indexBySourceSku, perLocationQuantities, sourcePairs } from '../match.js';

// R11 — a location present for a SKU in one source but absent from the other,
// when BOTH sources carry a location dimension. Per-location comparison skips
// such locations (nothing to compare against) and the health score only counts
// them as "unmatched"; this rule names them so a renamed, remapped or
// filtered-out location is visible instead of hiding inside a score.
export function locationOrphan(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const index = indexBySourceSku(records);

  for (const [a, b] of sourcePairs(records)) {
    const mapA = index.get(a)!;
    const mapB = index.get(b)!;

    for (const [canonical, bucketA] of mapA) {
      const bucketB = mapB.get(canonical);
      if (!bucketB) continue; // SKU-level orphans belong to sku-mismatch
      if (!hasLocationDimension(bucketA) || !hasLocationDimension(bucketB)) continue;

      const locA = perLocationQuantities(bucketA);
      const locB = perLocationQuantities(bucketB);
      const rawSku = bucketA.records[0]?.sku ?? canonical;

      const report = (present: string, missing: string, location: string | null) => {
        const label = location === null ? '(no location)' : `"${location}"`;
        findings.push({
          rule: 'location-orphan',
          severity: 'warning',
          sku: rawSku,
          message: `"${rawSku}" has location ${label} in ${present} but that location is absent from ${missing}`,
          detail: { sourceA: a, sourceB: b, location, presentIn: present, missingFrom: missing },
          suggestion: 'Check whether the location was renamed, remapped, deactivated or filtered out of one export before comparing quantities.',
          evidence: [`${present}: SKU has location ${label}.`, `${missing}: SKU has no row for that location.`],
          risk: 'If both sources should stock this SKU at the same location, inventory updates for that location may not reach the other source, and its quantity is excluded from per-location comparison.',
          assumptions: ['Location names are expected to match across the compared sources.'],
          verification: ['Compare location configuration, export filters and recent location renames or deactivations in both systems.'],
        });
      };

      for (const location of locA.keys()) {
        if (!locB.has(location)) report(a, b, location);
      }
      for (const location of locB.keys()) {
        if (!locA.has(location)) report(b, a, location);
      }
    }
  }
  return findings;
}
