import type { InventoryRecord } from '../../src/core/types.js';

export function rec(partial: Partial<InventoryRecord> & { source: string; sku: string | null }): InventoryRecord {
  const quantity = partial.quantity === undefined ? 1 : partial.quantity;
  return {
    barcode: null,
    title: null,
    location: null,
    tracked: null,
    meta: {},
    ...partial,
    quantity,
    quantityRaw: partial.quantityRaw ?? (quantity === null ? '' : String(quantity)),
  };
}
