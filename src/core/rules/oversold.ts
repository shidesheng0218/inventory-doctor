import { DEFAULT_DIAGNOSE_OPTIONS, type DiagnoseOptions, type Finding, type InventoryRecord } from '../types.js';
import { normalizeSku } from '../normalize.js';

// R8 — a negative reported quantity is a fact; orders and fulfillment are not inferred.
export function oversold(records: InventoryRecord[], options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const r of records) {
    if (r.quantity === null || r.quantity >= 0) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;

    // Duplicate rows for the same shelf are one problem, not two.
    const key = r.source + '\u0000' + canonical + '\u0000' + (r.location ?? '');
    if (seen.has(key)) continue;
    seen.add(key);

    const short = Math.abs(r.quantity);
    const where = r.location !== null ? ` at location "${r.location}"` : '';
    findings.push({
      rule: 'oversold',
      severity: options.allowBackorders ? 'info' : 'critical',
      sku: r.sku,
      message: `"${r.sku}" reports negative quantity ${r.quantity} (${short} below zero)${where} in ${r.source}`,
      detail: { source: r.source, location: r.location, quantity: r.quantity, short },
      suggestion:
        'Check quantity semantics, reservations, backorder policy, orders and physical stock before restocking or correcting the count.',
      evidence: [`${r.source}${where}: reported quantity ${r.quantity}.`],
      risk: 'If this quantity represents available stock and backorders are not intended, demand may exceed immediate fulfillment capacity; negative quantity alone does not prove accepted unfulfillable orders.',
      assumptions: [`Intentional backorders: ${options.allowBackorders === true}.`, 'Quantity meaning and physical stock have not been independently verified.'],
      verification: ['Check accepted orders, reservations, adjustments, stock counts and backorder policy.'],
    });
  }

  return findings;
}
