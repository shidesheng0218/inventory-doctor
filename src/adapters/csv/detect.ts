import { knownFieldsOf, mapHeaders, type CanonicalField } from './aliases.js';
import type { ParsedCsv } from './parse.js';

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

// A location column in a wide inventory table holds stock counts. To avoid
// misreading a descriptive column as a location (and its values as stock
// counts — the bug where Price 19.99 became "19 units at location Price"),
// we require BOTH of these signals:
//   1. The header is not a known descriptive/measurement column. A column
//      literally named "Price", "Weight", "Cost" etc. cannot be a warehouse.
//   2. The column's data contains at least one numeric value somewhere —
//      a column of pure free text (Product Name) is never a location.
// A genuinely numeric column with a neutral name (a bare warehouse code, a
// 3PL site id) still passes; a column named for money/dimensions never does.

// Headers that name money, dimensions, or identity — never a location.
const NON_LOCATION_HEADER = /price|cost|weight|amount|fee|rate|value|msrp|compare|dimension|length|width|height|image|photo|url|link|email|phone|description|vendor|brand|category|type|tag|status|date|created|updated/i;

// Headers that positively look like a place. If the name matches, we trust it
// even before looking at the data (warehouse/location/site/store/...).
const LOCATION_HEADER = /warehouse|location|store|site|bin|shelf|facility|depot|hub|stock|room|shop|outlet|branch|fulfil|fulfill/i;

function columnHasNumericValue(rows: Array<Record<string, string>>, header: string): boolean {
  for (const row of rows) {
    const raw = row[header];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue; // blank cells are fine — locations can be empty
    if (Number.isFinite(Number(trimmed))) return true;
  }
  return false;
}

function isLocationColumn(header: string, rows: Array<Record<string, string>>): boolean {
  if (NON_LOCATION_HEADER.test(header)) return false;
  if (LOCATION_HEADER.test(header)) return true; // named like a place — trust it
  // Neutral name: require the data to actually contain numbers.
  return columnHasNumericValue(rows, header);
}

export function detectFormat(headers: string[]): DetectionResult;
export function detectFormat(parsed: ParsedCsv): DetectionResult;
export function detectFormat(input: string[] | ParsedCsv): DetectionResult {
  const headers = Array.isArray(input) ? input : input.headers;
  const rows: Array<Record<string, string>> = Array.isArray(input) ? [] : input.rows;

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
  // and ≥1 unrecognized column that plausibly holds per-location stock counts.
  // isLocationColumn filters out descriptive/measurement columns (Price,
  // Weight, Product Name) so they are not misread as warehouses.
  if (has('sku') && !has('quantity') && !has('location')) {
    const candidates = headers.filter((h) => !fields.has(h) && h.trim() !== '');
    const locationColumns =
      rows.length === 0
        ? candidates.filter((h) => !NON_LOCATION_HEADER.test(h)) // header-only fallback
        : candidates.filter((h) => isLocationColumn(h, rows));
    if (locationColumns.length > 0) {
      return {
        format: 'shopify-inventory-wide',
        locationColumns,
        fields,
        reason: `SKU column but no quantity/location column; unrecognized headers that look like stock locations: ${locationColumns.join(', ')}`,
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
