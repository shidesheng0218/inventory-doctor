import type { InventoryRecord } from '../../core/types.js';
import type { CanonicalField } from './aliases.js';
import { blankToNull, parseQuantity, type ParsedCsv } from './parse.js';

export interface ColumnMapping {
  sku?: string;
  quantity?: string;
  barcode?: string;
  title?: string;
  location?: string;
}

// Generic CSV fallback: use the explicit column mapping when given, otherwise
// whatever the alias dictionary already recognized. Unknown columns are kept
// in meta so nothing is silently dropped.
export function parseGenericCsv(
  parsed: ParsedCsv,
  source: string,
  fields: Map<string, CanonicalField>,
  mapping: ColumnMapping = {},
): InventoryRecord[] {
  const pickHeader = (field: CanonicalField, explicit?: string): string | undefined => {
    if (explicit && parsed.headers.includes(explicit)) return explicit;
    for (const [header, f] of fields) {
      if (f === field) return header;
    }
    return undefined;
  };

  const skuHeader = pickHeader('sku', mapping.sku);
  const quantityHeader = pickHeader('quantity', mapping.quantity);
  const barcodeHeader = pickHeader('barcode', mapping.barcode);
  const titleHeader = pickHeader('title', mapping.title);
  const locationHeader = pickHeader('location', mapping.location);

  if (!skuHeader) {
    const recognized = [...fields.entries()].map(([header, field]) => `${header} → ${field}`);
    throw new Error(
      `Unrecognized CSV format in ${source}: no SKU column could be identified.\n` +
        `Headers seen: ${parsed.headers.join(', ') || '(none)'}\n` +
        `Recognized columns: ${recognized.length > 0 ? recognized.join(', ') : '(none)'}\n` +
        `Pass an explicit column mapping, e.g.: --map sku="${parsed.headers[0] ?? 'MSKU'}" --map quantity="Qty" ` +
        `(fields: sku, quantity, barcode, title, location)`,
    );
  }

  const knownHeaders = new Set<string>([...fields.keys()]);
  for (const h of [skuHeader, quantityHeader, barcodeHeader, titleHeader, locationHeader]) {
    if (h) knownHeaders.add(h);
  }

  const records: InventoryRecord[] = [];
  for (const row of parsed.rows) {
    const sku = blankToNull(row[skuHeader]);
    if (sku === null) continue;
    const { quantity, quantityRaw } = parseQuantity(quantityHeader ? row[quantityHeader] : undefined);

    const meta: Record<string, string> = {};
    for (const header of parsed.headers) {
      if (knownHeaders.has(header)) continue;
      const v = row[header];
      if (v !== undefined && v !== '') meta[header] = v;
    }

    records.push({
      source,
      sku,
      barcode: barcodeHeader ? blankToNull(row[barcodeHeader]) : null,
      title: titleHeader ? blankToNull(row[titleHeader]) : null,
      location: locationHeader ? blankToNull(row[locationHeader]) : null,
      quantity,
      quantityRaw,
      tracked: null,
      meta,
    });
  }
  return records;
}
