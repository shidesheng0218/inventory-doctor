import type { InventoryRecord } from '../../core/types.js';
import { parseCsvContent } from './parse.js';
import { detectFormat, type DetectionResult } from './detect.js';
import { parseShopifyProductCsv } from './shopify-product.js';
import { parseInventoryLong, parseInventoryWide } from './shopify-inventory.js';
import { parseGenericCsv, type ColumnMapping } from './generic.js';

export interface CsvAdapterResult {
  records: InventoryRecord[];
  detection: DetectionResult;
}

// One entry point: detect the layout, dispatch to the right adapter.
// Explicit column mappings take precedence over automatic layout detection.
export function loadCsv(content: string, source: string, mapping: ColumnMapping = {}): CsvAdapterResult {
  const parsed = parseCsvContent(content, source);
  const detection = detectFormat(parsed);
  for (const [field, header] of Object.entries(mapping)) {
    if (header !== undefined && !parsed.headers.includes(header)) {
      throw new Error(`Invalid CSV in ${source}: mapped ${field} column ${JSON.stringify(header)} does not exist. Headers seen: ${parsed.headers.join(', ')}`);
    }
  }
  // Explicit mappings define a row-based layout and take precedence over
  // automatic Shopify detection (including its quantity/location choices).
  if (Object.values(mapping).some((header) => header !== undefined)) {
    detection.format = 'generic';
    detection.locationColumns = [];
    detection.reason = 'explicit column mapping takes precedence over automatic detection';
  }
  const quantityField = detection.format === 'shopify-inventory-long'
    ? ['available', 'onHandCurrent']
    : ['quantity'];
  if (detection.format !== 'shopify-inventory-wide' && !mapping.quantity &&
      ![...detection.fields.values()].some((field) => quantityField.includes(field))) {
    // Generic emits the detailed missing-SKU message first when neither exists.
    if ([...detection.fields.values()].includes('sku') || mapping.sku) {
      throw new Error(`Invalid CSV in ${source}: no quantity column could be identified. Headers seen: ${parsed.headers.join(', ')}`);
    }
  }

  let records: InventoryRecord[];
  switch (detection.format) {
    case 'shopify-product':
      records = parseShopifyProductCsv(parsed, source, detection.fields);
      break;
    case 'shopify-inventory-long':
      records = parseInventoryLong(parsed, source, detection.fields);
      break;
    case 'shopify-inventory-wide':
      records = parseInventoryWide(parsed, source, detection.fields, detection.locationColumns);
      break;
    case 'generic':
      records = parseGenericCsv(parsed, source, detection.fields, mapping);
      break;
  }
  return { records, detection };
}
