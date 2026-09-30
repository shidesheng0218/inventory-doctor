import type { InventoryRecord } from '../../core/types.js';
import type { WooClient } from './client.js';

// WooCommerce product/variation → InventoryRecord.
//   - manage_stock=false → quantity null + tracked=false: the `untracked`
//     rule then works unchanged, same as Shopify's tracker-off state.
//   - backorders yes/notify → meta.inventoryPolicy="continue": reuses the
//     oversell-risk continue-selling check verbatim.
//   - Blank SKU stays null — rules skip null SKUs, matching CSV behavior.
// WooCommerce core has no multi-location inventory, so location is null.

interface WooStockFields {
  sku: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  backorders: 'no' | 'notify' | 'yes';
}

interface WooProduct extends WooStockFields {
  id: number;
  name: string;
  type: string; // "simple" | "variable" | "grouped" | "external" | ...
}

interface WooVariation extends WooStockFields {
  id: number;
  attributes: Array<{ name: string; option: string }>;
}

function toRecord(source: string, title: string, fields: WooStockFields): InventoryRecord {
  const sku = fields.sku.trim() === '' ? null : fields.sku;
  const quantity = fields.manage_stock && fields.stock_quantity !== null ? Math.trunc(fields.stock_quantity) : null;
  return {
    source,
    sku,
    barcode: null, // WooCommerce core has no barcode field
    title: title.trim() === '' ? null : title,
    location: null,
    quantity,
    quantityRaw: quantity === null ? '' : String(quantity),
    tracked: fields.manage_stock,
    meta: { inventoryPolicy: fields.backorders === 'no' ? 'deny' : 'continue' },
  };
}

export async function fetchWooInventory(client: WooClient, source: string): Promise<InventoryRecord[]> {
  const products = await client.getAll<WooProduct>('/products?status=publish');
  const records: InventoryRecord[] = [];

  for (const product of products) {
    if (product.type === 'variable') {
      const variations = await client.getAll<WooVariation>(`/products/${product.id}/variations`);
      for (const v of variations) {
        const variantLabel = v.attributes.map((a) => a.option).filter((o) => o !== '').join(' / ');
        const title = variantLabel === '' ? product.name : `${product.name} — ${variantLabel}`;
        records.push(toRecord(source, title, v));
      }
      continue;
    }
    if (product.type === 'grouped' || product.type === 'external') continue;
    records.push(toRecord(source, product.name, product));
  }

  return records;
}
