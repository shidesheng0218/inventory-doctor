import type { InventoryRecord } from '../../src/core/types.js';

export function rec(partial: Partial<InventoryRecord> & { source: string; sku: string | null }): InventoryRecord {
  const quantity = partial.quantity === undefined ? 1 : partial.quantity;
  const quantityRaw = partial.quantityRaw ?? (quantity === null ? '' : String(quantity));
  return {
    barcode: null,
    title: null,
    location: null,
    tracked: null,
    meta: {},
    ...partial,
    quantity,
    quantityRaw,
    // "cellIsBlank" explicitly present (even as null) wins; otherwise infer
    // from quantityRaw so plain CSV-style test fixtures keep firing the rule.
    cellIsBlank:
      'cellIsBlank' in partial ? (partial.cellIsBlank ?? null) : quantityRaw.trim() === '',
  };
}
