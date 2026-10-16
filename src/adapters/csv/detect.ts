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

// Inferring locations from numeric data is unsafe: Years, Rank and Pack Size
// can all be integers. Require an explicit place-like header instead. Known
// descriptive fields are excluded even if their name also contains "stock".
const NON_LOCATION_HEADER = /price|cost|weight|amount|fee|rate|value|msrp|compare|dimension|length|width|height|image|photo|url|link|email|phone|description|vendor|brand|category|type|tag|status|date|created|updated|age|year|rank|size|count|number|code|id\b/i;
const LOCATION_HEADER = /\b(?:warehouse|location|store|site|bin|shelf|facility|depot|hub|stockroom|room|shop|outlet|branch|fulfilment|fulfillment)\b/i;

export function detectFormat(headers: string[]): DetectionResult;
export function detectFormat(parsed: ParsedCsv): DetectionResult;
export function detectFormat(input: string[] | ParsedCsv): DetectionResult {
  const headers = Array.isArray(input) ? input : input.headers;

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
  // Positive place-like headers exclude descriptive/measurement columns.
  if (has('sku') && !has('quantity') && !has('location')) {
    const candidates = headers.filter((h) => !fields.has(h) && h.trim() !== '');
    const locationColumns = candidates.filter((h) => !NON_LOCATION_HEADER.test(h) && LOCATION_HEADER.test(h));
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
