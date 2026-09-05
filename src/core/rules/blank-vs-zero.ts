import type { Finding, InventoryRecord } from '../types.js';
import { groupByCanonicalSku, distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';

// R3 — blank cell vs explicit "0". A blank quantity cell is the classic root
// cause of "the import wiped my inventory": many tools read blank as 0.
export function blankVsZero(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const sources = distinctSources(records);

  for (const r of records) {
    if (r.sku === null || normalizeSku(r.sku).canonical === '') continue;
    if (r.quantityRaw.trim() !== '') continue; // only truly blank cells

    // Is this SKU managed (with a real quantity) in another source? Then the
    // blank is dangerous: a sync could overwrite that quantity with 0.
    let managedElsewhere: string | null = null;
    if (sources.length > 1) {
      for (const other of sources) {
        if (other === r.source) continue;
        const grouped = groupByCanonicalSku(records, other);
        const bucket = grouped.get(normalizeSku(r.sku).canonical);
        if (bucket && bucket.records.some((x) => x.quantity !== null)) {
          managedElsewhere = other;
          break;
        }
      }
    }

    const where = r.location !== null ? ` at location "${r.location}"` : '';
    findings.push({
      rule: 'blank-vs-zero',
      severity: 'critical',
      sku: r.sku,
      message:
        managedElsewhere !== null
          ? `"${r.sku}" has a BLANK quantity cell in ${r.source}${where} (not "0") while ${managedElsewhere} tracks a real quantity — an import may read this as 0 and wipe the stock`
          : `"${r.sku}" has a BLANK quantity cell in ${r.source}${where} (not "0") — imports may silently treat this as 0`,
      detail: {
        source: r.source,
        location: r.location,
        quantityRaw: r.quantityRaw,
        managedElsewhere,
        isExplicitZero: false,
      },
      suggestion: 'Write an explicit "0" if the item is truly out of stock, or fill in the real quantity. Never leave quantity cells blank before a bulk import.',
    });
  }

  return findings;
}
