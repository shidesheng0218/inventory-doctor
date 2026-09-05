import { knownFieldsOf, mapHeaders, type CanonicalField } from './aliases.js';

export type CsvFormat =
  | 'shopify-product' // product export (old or new header names)
  | 'shopify-inventory-long' // one row per variant × location
  | 'shopify-inventory-wide' // location names as column headers
  | 'generic'; // anything else — needs column probing / mapping

export interface DetectionResult {
  format: CsvFormat;
  // For wide tables: headers inferred to be location columns.
  locationColumns: string[];
  // Raw header → canonical field, for everything we recognized.
  fields: Map<string, CanonicalField>;
  reason: string;
}

export function detectFormat(headers: string[]): DetectionResult {
  const fields = mapHeaders(headers);
  const known = knownFieldsOf(headers);

  const has = (f: CanonicalField) => known.has(f);

  // Shopify inventory LONG table: SKU + a Location column + state columns.
  if (has('sku') && has('location') && (has('available') || has('onHandCurrent') || has('onHandNew') || has('incoming') || has('committed'))) {
    return {
      format: 'shopify-inventory-long',
      locationColumns: [],
      fields,
      reason: 'SKU + Location column + inventory state columns → Shopify inventory export (long format)',
    };
  }

  // Shopify product CSV: handle + sku + quantity (either header generation).
  if (has('handle') && has('sku') && has('quantity')) {
    return {
      format: 'shopify-product',
      locationColumns: [],
      fields,
      reason: 'handle + SKU + quantity columns → Shopify product export',
    };
  }

  // Shopify inventory WIDE table: sku present, no quantity/location column,
  // and ≥1 unrecognized column — those are the per-location quantity columns.
  if (has('sku') && !has('quantity') && !has('location')) {
    const locationColumns = headers.filter((h) => !fields.has(h) && h.trim() !== '');
    if (locationColumns.length > 0) {
      return {
        format: 'shopify-inventory-wide',
        locationColumns,
        fields,
        reason: `SKU column but no quantity/location column; unrecognized headers treated as locations: ${locationColumns.join(', ')}`,
      };
    }
  }

  return {
    format: 'generic',
    locationColumns: [],
    fields,
    reason: 'unrecognized layout — falling back to alias-based column probing',
  };
}
