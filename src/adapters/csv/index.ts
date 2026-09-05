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
export function loadCsv(content: string, source: string, mapping: ColumnMapping = {}): CsvAdapterResult {
  const parsed = parseCsvContent(content);
  const detection = detectFormat(parsed.headers);

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
