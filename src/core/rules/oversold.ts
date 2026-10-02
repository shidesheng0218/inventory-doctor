import type { Finding, InventoryRecord } from '../types.js';
import { normalizeSku } from '../normalize.js';

// R8 — already oversold: available quantity is negative, which means more
// units are committed than exist on hand.
//
// Every other oversell signal needs a second source to compare against, which
// is why a single-store deployment had nothing to say on day one. This one is
// true of one store, right now, and it is the clearest "you are selling stock
// you do not have" signal there is.
//
// Reported per (sku, location) because that is where the correction has to
// happen; a source with no location dimension reports per SKU.
export function oversold(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const r of records) {
    if (r.quantity === null || r.quantity >= 0) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;

    // Duplicate rows for the same shelf are one problem, not two.
    const key = canonical + '\u0000' + (r.location ?? '');
    if (seen.has(key)) continue;
    seen.add(key);

    const short = Math.abs(r.quantity);
    const where = r.location !== null ? ` at location "${r.location}"` : '';
    findings.push({
      rule: 'oversold',
      severity: 'critical',
      sku: r.sku,
      message: `"${r.sku}" is oversold by ${short} unit${short === 1 ? '' : 's'}${where} in ${r.source}: available is ${r.quantity}`,
      detail: { source: r.source, location: r.location, quantity: r.quantity, short },
      suggestion:
        'Restock, or correct the count: negative availability means orders were accepted for stock that is not there. Check whether "continue selling when out of stock" is on, and whether a recent import or sync lowered the count.',
    });
  }

  return findings;
}
