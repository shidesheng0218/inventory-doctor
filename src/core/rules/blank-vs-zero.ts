import type { Finding, InventoryRecord } from '../types.js';
import { groupByCanonicalSku, distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';

// R3 — blank cell vs explicit "0". A blank quantity cell is the classic root
// cause of "the import wiped my inventory": many tools read blank as 0.
//
// The trigger is `cellIsBlank === true`, which only CSV adapters set — a live
// API read has no "blank cell" (a null quantity there means untracked), so
// records from Shopify/WooCommerce API carry cellIsBlank=null and never fire.
export function blankVsZero(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const sources = distinctSources(records);
  // Group each source once up front; doing it per record is O(records × sources).
  const groupedBySource =
    sources.length > 1 ? new Map(sources.map((s) => [s, groupByCanonicalSku(records, s)])) : null;

  for (const r of records) {
    if (r.sku === null || normalizeSku(r.sku).canonical === '') continue;
    if (r.cellIsBlank !== true) continue; // only genuine blank cells, from CSV sources

    // Is this SKU managed (with a real quantity) in another source? Then the
    // blank is dangerous: a sync could overwrite that quantity with 0.
    let managedElsewhere: string | null = null;
    if (groupedBySource !== null) {
      for (const other of sources) {
        if (other === r.source) continue;
        const bucket = groupedBySource.get(other)?.get(normalizeSku(r.sku).canonical);
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
          ? `"${r.sku}" has a BLANK quantity cell in ${r.source}${where} (not "0") while ${managedElsewhere} tracks a real quantity`
          : `"${r.sku}" has a BLANK quantity cell in ${r.source}${where} (not "0")`,
      detail: {
        source: r.source,
        location: r.location,
        quantityRaw: r.quantityRaw,
        managedElsewhere,
        isExplicitZero: false,
      },
      suggestion: 'Check how the intended importer handles blanks (ignore, clear or zero); enter a verified quantity only if an update is intended.',
      evidence: [`${r.source}${where}: quantity cell is blank, not an explicit zero.`],
      risk: 'If the importer converts blanks to zero and applies inventory updates, this cell could overwrite stock with zero. Import behavior is not established by the CSV.',
      assumptions: ['The file will be imported using a mode that updates inventory.'],
      verification: ['Check importer blank-cell behavior, update mode, SKU/location mapping and intended stock before importing.'],
    });
  }

  return findings;
}
