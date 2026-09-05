import type { InventoryRecord } from '../../core/types.js';
import type { ShopifyClient } from './client.js';

// Main snapshot query. Notes that matter:
//   - InventoryLevel.available is GONE; quantities(names: [...]) is the only
//     read path and `names` has no default — it must be passed explicitly.
//   - inventoryLevels needs includeInactive: true to cover all locations.
//   - inventoryQuantity = total available across locations (still valid).
const INVENTORY_SNAPSHOT_QUERY = /* GraphQL */ `
  query InventorySnapshot($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      nodes {
        sku
        barcode
        title
        inventoryQuantity
        inventoryPolicy
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20, includeInactive: true) {
            nodes {
              location { id name }
              quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                name
                quantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface QuantityNode {
  name: string;
  quantity: number;
}

interface InventoryLevelNode {
  location: { id: string; name: string };
  quantities: QuantityNode[];
}

interface VariantNode {
  sku: string | null;
  barcode: string | null;
  title: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: { nodes: InventoryLevelNode[] };
  } | null;
}

interface SnapshotResponse {
  productVariants: {
    nodes: VariantNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// Page through every variant (cursor-based, cursors are opaque — never
// fabricated) and flatten to InventoryRecord[]. One record per location when
// levels exist, otherwise one record with the variant-level quantity.
export async function fetchInventory(client: ShopifyClient, source: string): Promise<InventoryRecord[]> {
  const records: InventoryRecord[] = [];
  let cursor: string | null = null;

  for (;;) {
    const variables: Record<string, unknown> = cursor === null ? {} : { cursor };
    const data = await client.graphql<SnapshotResponse>(INVENTORY_SNAPSHOT_QUERY, variables);

    for (const variant of data.productVariants.nodes) {
      const sku = variant.sku === null || variant.sku.trim() === '' ? null : variant.sku;
      if (sku === null) continue;

      const base = {
        source,
        sku,
        barcode: variant.barcode?.trim() ? variant.barcode : null,
        title: variant.title,
        tracked: variant.inventoryItem?.tracked ?? null,
      };
      const meta: Record<string, string> = {};
      if (variant.inventoryPolicy) meta['inventoryPolicy'] = variant.inventoryPolicy.toLowerCase();

      const levels = variant.inventoryItem?.inventoryLevels.nodes ?? [];
      if (levels.length === 0) {
        const qty = variant.inventoryQuantity;
        records.push({
          ...base,
          location: null,
          quantity: qty,
          quantityRaw: qty === null ? '' : String(qty),
          meta,
        });
        continue;
      }

      for (const level of levels) {
        const available = level.quantities.find((q) => q.name === 'available');
        const levelMeta = { ...meta };
        for (const q of level.quantities) {
          if (q.name !== 'available') levelMeta[q.name] = String(q.quantity);
        }
        records.push({
          ...base,
          location: level.location.name,
          quantity: available?.quantity ?? null,
          quantityRaw: available === undefined ? '' : String(available.quantity),
          meta: levelMeta,
        });
      }
    }

    const pageInfo = data.productVariants.pageInfo;
    if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
    cursor = pageInfo.endCursor;
  }

  return records;
}
