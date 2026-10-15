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
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// A variant with more than 20 locations would be silently truncated by the
// main query (inventoryLevels(first: 20) returns no error, just a capped
// list). Multi-location is exactly the scenario this tool exists for, so when
// a variant reports hasNextPage on its levels we page the rest in explicitly.
const INVENTORY_LEVELS_PAGE_QUERY = /* GraphQL */ `
  query InventoryLevelsPage($itemId: ID!, $cursor: String) {
    inventoryItem(id: $itemId) {
      id
      inventoryLevels(first: 250, after: $cursor, includeInactive: true) {
        nodes {
          location { id name }
          quantities(names: ["available", "on_hand", "committed", "incoming"]) {
            name
            quantity
          }
        }
        pageInfo { hasNextPage endCursor }
      }
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

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
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
    inventoryLevels: { nodes: InventoryLevelNode[]; pageInfo: PageInfo };
  } | null;
}

interface SnapshotResponse {
  productVariants: {
    nodes: VariantNode[];
    pageInfo: PageInfo;
  };
}

interface LevelsPageResponse {
  inventoryItem: {
    id: string;
    inventoryLevels: { nodes: InventoryLevelNode[]; pageInfo: PageInfo };
  } | null;
}

// Follow a variant's inventoryLevels pagination past the first page of 20.
// Only called when the main query reports hasNextPage for that variant.
async function fetchRemainingLevels(
  client: ShopifyClient,
  itemId: string,
  startCursor: string | null,
  already: InventoryLevelNode[],
): Promise<InventoryLevelNode[]> {
  const all = [...already];
  let cursor = startCursor;
  while (cursor !== null) {
    const data = await client.graphql<LevelsPageResponse>(INVENTORY_LEVELS_PAGE_QUERY, {
      itemId,
      cursor,
    });
    const levels = data.inventoryItem?.inventoryLevels;
    if (!levels) break;
    all.push(...levels.nodes);
    cursor = levels.pageInfo.hasNextPage ? levels.pageInfo.endCursor : null;
  }
  return all;
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

      let levels = variant.inventoryItem?.inventoryLevels.nodes ?? [];
      // A variant with >20 locations is truncated by the main query's
      // inventoryLevels(first: 20). Page the remainder in rather than silently
      // dropping locations — multi-location is the core scenario.
      const levelsPageInfo = variant.inventoryItem?.inventoryLevels.pageInfo;
      const itemId = variant.inventoryItem?.id;
      if (levelsPageInfo?.hasNextPage && itemId) {
        levels = await fetchRemainingLevels(client, itemId, levelsPageInfo.endCursor, levels);
      }
      if (levels.length === 0) {
        const qty = variant.inventoryQuantity;
        records.push({
          ...base,
          location: null,
          quantity: qty,
          quantityRaw: qty === null ? '' : String(qty),
          // Live API read: "blank cell" does not exist here. A null quantity
          // means untracked, not empty — so blank-vs-zero must not fire.
          cellIsBlank: null,
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
          cellIsBlank: null,
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
