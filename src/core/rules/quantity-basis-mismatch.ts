import type { Finding, InventoryRecord, QuantityBasis } from '../types.js';
import { indexBySourceSku } from '../match.js';

// R10 — quantities from sources with different quantity semantics (available vs
// on-hand vs product-level inventory vs unknown) are not directly comparable.
// The comparison rules still run; this finding tells the reader that numeric
// differences (or agreement) may reflect measurement differences.
//
// Reported once per source pair and SKU, only when the SKU exists in both
// sources and at least one record on each side carries a numeric quantity.
export function quantityBasisMismatch(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const index = indexBySourceSku(records);
  const sources = [...index.keys()];

  const basisOf = (bucketRecords: InventoryRecord[]): QuantityBasis => {
    const bases = new Set(
      bucketRecords.filter((r) => r.quantity !== null).map((r) => r.quantityBasis ?? 'unknown'),
    );
    if (bases.size === 0) return 'unknown';
    if (bases.size === 1) return [...bases][0] as QuantityBasis;
    return 'unknown'; // mixed bases inside one source: do not claim a single semantics
  };

  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i] as string;
      const b = sources[j] as string;
      const mapA = index.get(a)!;
      const mapB = index.get(b)!;

      for (const [canonical, bucketA] of mapA) {
        const bucketB = mapB.get(canonical);
        if (!bucketB) continue;
        const hasNumeric = (rs: InventoryRecord[]) => rs.some((r) => r.quantity !== null);
        if (!hasNumeric(bucketA.records) || !hasNumeric(bucketB.records)) continue;

        const basisA = basisOf(bucketA.records);
        const basisB = basisOf(bucketB.records);
        // Two identical, explicitly known bases are comparable.
        if (basisA === basisB && basisA !== 'unknown') continue;

        const rawSku = bucketA.records[0]?.sku ?? canonical;
        const bothUnknown = basisA === 'unknown' && basisB === 'unknown';
        findings.push({
          rule: 'quantity-basis-mismatch',
          severity: bothUnknown ? 'info' : 'warning',
          sku: rawSku,
          message: bothUnknown
            ? `"${rawSku}": quantity meaning is unknown in both ${a} and ${b}; numeric comparison assumes the same stock state`
            : `"${rawSku}": ${a} reports ${basisA} quantity but ${b} reports ${basisB} quantity; numbers may not be directly comparable`,
          detail: { sourceA: a, sourceB: b, basisA, basisB },
          suggestion:
            'Confirm which stock state each source reports (available, on hand, committed) before treating quantity differences or agreement as meaningful.',
          evidence: [`${a}: quantity basis ${basisA}.`, `${b}: quantity basis ${basisB}.`],
          risk: 'If the sources report different stock states, a quantity difference may reflect measurement semantics rather than a sync problem, and matching numbers may hide one.',
          assumptions: ['Quantity basis is inferred from column names or API fields; "unknown" means it could not be established.'],
          verification: ['Check export headers or API fields to confirm whether each quantity is available, on hand, or a platform-managed count.'],
        });
      }
    }
  }
  return findings;
}
