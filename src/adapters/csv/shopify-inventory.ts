import type { InventoryRecord } from '../../core/types.js';
import type { CanonicalField } from './aliases.js';
import { blankToNull, parseQuantity, type ParsedCsv } from './parse.js';

function headerFor(fields: Map<string, CanonicalField>, field: CanonicalField): string | undefined {
  for (const [header, f] of fields) {
    if (f === field) return header;
  }
  return undefined;
}

// Shopify inventory export — LONG format ("All states"): one row per
// variant × location. Quantity basis is "Available (not editable)"; the other
// state columns are kept in meta.
export function parseInventoryLong(parsed: ParsedCsv, source: string, fields: Map<string, CanonicalField>): InventoryRecord[] {
  const records: InventoryRecord[] = [];
  for (const row of parsed.rows) {
    const skuHeader = headerFor(fields, 'sku');
    const sku = blankToNull(skuHeader ? row[skuHeader] : undefined);
    if (sku === null) continue;

    const locationHeader = headerFor(fields, 'location');
    const availableHeader = headerFor(fields, 'available') ?? headerFor(fields, 'onHandCurrent');
    const { quantity, quantityRaw } = parseQuantity(availableHeader ? row[availableHeader] : undefined);

    const meta: Record<string, string> = {};
    for (const stateField of ['incoming', 'unavailable', 'committed', 'onHandCurrent', 'onHandNew', 'binName'] as CanonicalField[]) {
      const h = headerFor(fields, stateField);
      const v = h ? row[h] : undefined;
      if (v !== undefined && v.trim() !== '') meta[stateField] = v.trim();
    }

    records.push({
      source,
      sku,
      barcode: blankToNull(headerFor(fields, 'barcode') ? row[headerFor(fields, 'barcode') as string] : undefined),
      title: blankToNull(headerFor(fields, 'title') ? row[headerFor(fields, 'title') as string] : undefined),
      location: blankToNull(locationHeader ? row[locationHeader] : undefined),
      quantity,
      quantityRaw,
      tracked: null,
      meta,
    });
  }
  return records;
}

// Shopify inventory export — WIDE format ("Available"): location names ARE
// column headers; each location cell becomes its own record so the rest of
// the pipeline never has to care which shape the file was.
export function parseInventoryWide(
  parsed: ParsedCsv,
  source: string,
  fields: Map<string, CanonicalField>,
  locationColumns: string[],
): InventoryRecord[] {
  const records: InventoryRecord[] = [];
  for (const row of parsed.rows) {
    const skuHeader = headerFor(fields, 'sku');
    const sku = blankToNull(skuHeader ? row[skuHeader] : undefined);
    if (sku === null) continue;

    const barcode = blankToNull(headerFor(fields, 'barcode') ? row[headerFor(fields, 'barcode') as string] : undefined);
    const title = blankToNull(headerFor(fields, 'title') ? row[headerFor(fields, 'title') as string] : undefined);

    for (const locationColumn of locationColumns) {
      const { quantity, quantityRaw } = parseQuantity(row[locationColumn]);
      records.push({
        source,
        sku,
        barcode,
        title,
        location: locationColumn,
        quantity,
        quantityRaw,
        tracked: null,
        meta: {},
      });
    }
  }
  return records;
}
