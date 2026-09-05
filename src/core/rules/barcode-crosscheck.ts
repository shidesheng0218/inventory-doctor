import type { Finding, InventoryRecord } from '../types.js';
import { normalizeSku } from '../normalize.js';

// R4 — same barcode, different SKU across sources: the products are the same
// physical item but the SKU mapping is misconfigured. Silent and nasty.
export function barcodeCrosscheck(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];
  const byBarcode = new Map<string, InventoryRecord[]>();

  for (const r of records) {
    if (r.barcode === null) continue;
    const barcode = r.barcode.trim();
    if (barcode === '') continue;
    const list = byBarcode.get(barcode) ?? [];
    list.push(r);
    byBarcode.set(barcode, list);
  }

  for (const [barcode, list] of byBarcode) {
    const skuKeys = new Map<string, InventoryRecord>();
    for (const r of list) {
      if (r.sku === null) continue;
      const key = normalizeSku(r.sku).canonical;
      if (!skuKeys.has(key)) skuKeys.set(key, r);
    }
    if (skuKeys.size < 2) continue;
    const involvedSources = new Set(list.map((r) => r.source));
    if (involvedSources.size < 2) continue; // same-source barcode reuse is a different problem

    const entries = [...skuKeys.values()].map((r) => ({ sku: r.sku, source: r.source, title: r.title }));
    findings.push({
      rule: 'barcode-crosscheck',
      severity: 'critical',
      sku: entries[0]?.sku ?? null,
      message: `Barcode ${barcode} maps to ${skuKeys.size} different SKUs across sources (${entries.map((e) => `"${e.sku}" in ${e.source}`).join(' vs ')}) — the SKU mapping is likely misconfigured`,
      detail: { barcode, entries },
      suggestion: 'These records share one barcode, so they are almost certainly the same product. Align the SKU in all sources, or fix the barcode on the wrong record.',
    });
  }

  return findings;
}
