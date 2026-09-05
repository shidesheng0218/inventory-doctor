import type { Finding, InventoryRecord } from '../types.js';
import { groupByCanonicalSku, distinctSources } from '../match.js';
import { normalizeSku } from '../normalize.js';

// R6 — inventory tracker off in one source while another source manages stock
// for the same SKU: the untracked side will never decrement, so sync drifts.
export function untracked(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const sources = distinctSources(records);

  for (const r of records) {
    if (r.tracked !== false) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;

    let managedElsewhere: string | null = null;
    for (const other of sources) {
      if (other === r.source) continue;
      const bucket = groupByCanonicalSku(records, other).get(canonical);
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
      suggestion: `Enable inventory tracking for "${r.sku}" in ${r.source}, otherwise its quantity will never decrement and sync will silently drift.`,
    });
  }

  return findings;
}
