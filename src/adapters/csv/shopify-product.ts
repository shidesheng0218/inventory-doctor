import type { InventoryRecord } from '../../core/types.js';
import type { CanonicalField } from './aliases.js';
import { blankToNull, parseQuantity, type ParsedCsv } from './parse.js';

// Shopify product CSV export (both header generations, resolved via aliases).
// One record per variant row; no location dimension (product exports don't
// carry per-location inventory).
export function parseShopifyProductCsv(parsed: ParsedCsv, source: string, fields: Map<string, CanonicalField>): InventoryRecord[] {
  const get = (row: Record<string, string>, field: CanonicalField): string | undefined => {
    for (const [header, f] of fields) {
      if (f === field) return row[header];
    }
    return undefined;
  };

  const records: InventoryRecord[] = [];
  for (const row of parsed.rows) {
    const sku = blankToNull(get(row, 'sku'));
    // Product exports repeat the title on the first row of each handle group;
    // rows without a SKU are option-less placeholders — skip them.
    if (sku === null) continue;

    const { quantity, quantityRaw } = parseQuantity(get(row, 'quantity'));
    const trackedRaw = get(row, 'tracked');
    const tracked =
      trackedRaw === undefined
        ? null
        : trackedRaw.trim() === ''
          ? false
          : trackedRaw.trim().toLowerCase() === 'shopify';

    const meta: Record<string, string> = {};
    const policy = blankToNull(get(row, 'inventoryPolicy'));
    if (policy !== null) meta['inventoryPolicy'] = policy.trim().toLowerCase();
    for (const [header, value] of Object.entries(row)) {
      if (!fields.has(header) && value !== undefined && value !== '') meta[header] = value;
    }

    records.push({
      source,
      sku,
      barcode: blankToNull(get(row, 'barcode')),
      title: blankToNull(get(row, 'title')),
      location: null,
      quantity,
      quantityRaw,
      tracked,
      meta,
    });
  }
  return records;
}
