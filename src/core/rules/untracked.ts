import type { Finding, InventoryRecord } from '../types.js';
import { groupByCanonicalSku, distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';

// R6 — inventory tracker off in one source while another source manages stock
// for the same SKU: the untracked side will never decrement, so sync drifts.
export function untracked(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const sources = distinctSources(records);
  // Group each source once up front; doing it per record is O(records × sources).
  const groupedBySource = new Map(sources.map((s) => [s, groupByCanonicalSku(records, s)]));

  for (const r of records) {
    if (r.tracked !== false) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;

    let managedElsewhere: string | null = null;
    for (const other of sources) {
      if (other === r.source) continue;
      const bucket = groupedBySource.get(other)?.get(canonical);
      if (bucket && bucket.records.some((x) => x.tracked === true || x.quantity !== null)) {
        managedElsewhere = other;
        break;
      }
    }
    if (managedElsewhere === null) continue;

    findings.push({
      rule: 'untracked',
      severity: 'info',
      sku: r.sku,
      message: `"${r.sku}" has inventory tracking OFF in ${r.source} but is stock-managed in ${managedElsewhere}`,
      detail: { source: r.source, managedElsewhere, tracked: r.tracked },
      suggestion: `Confirm whether "${r.sku}" should be stock-managed in ${r.source}; check external inventory management and backorder policies before enabling tracking.`,
    });
  }

  return findings;
}
