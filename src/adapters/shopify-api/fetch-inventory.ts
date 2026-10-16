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

// Cursor progress is a completeness invariant, not a best-effort hint. Never
// return a snapshot that silently omitted the rest of a connection.
function nextCursor<T>(
  connection: { nodes: T[]; pageInfo: PageInfo } | null | undefined,
  seen: Set<string>,
  context: string,
  isContinuation: boolean,
): string | null {
  if (!connection || !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error(`Incomplete Shopify snapshot (${context}): missing connection/pageInfo`);
  }
  if (connection.nodes.length === 0 && (isContinuation || connection.pageInfo.hasNextPage)) {
    throw new Error(`Incomplete Shopify snapshot (${context}): empty pagination page`);
  }
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (typeof cursor !== 'string' || cursor.trim() === '') {
    throw new Error(`Incomplete Shopify snapshot (${context}): hasNextPage requires a nonempty cursor`);
  }
  if (seen.has(cursor)) {
    throw new Error(`Incomplete Shopify snapshot (${context}): repeated cursor ${JSON.stringify(cursor)}`);
  }
  seen.add(cursor);
  return cursor;
}

async function fetchRemainingLevels(
  client: ShopifyClient,
  itemId: string,
  startCursor: string,
  already: InventoryLevelNode[],
  source: string,
): Promise<InventoryLevelNode[]> {
  const all = [...already];
  const seen = new Set([startCursor]);
  let cursor: string | null = startCursor;
  while (cursor !== null) {
    const data: LevelsPageResponse = await client.graphql<LevelsPageResponse>(INVENTORY_LEVELS_PAGE_QUERY, { itemId, cursor });
    if (!data.inventoryItem || data.inventoryItem.id !== itemId) {
      throw new Error(`Incomplete Shopify snapshot (${source}, inventory item ${itemId}): object disappeared or changed`);
    }
    const levels = data.inventoryItem.inventoryLevels;
    cursor = nextCursor(levels, seen, `${source}, inventory item ${itemId}`, true);
    all.push(...levels.nodes);
  }
  return all;
}

// Page through every variant (cursor-based, cursors are opaque — never
// fabricated) and flatten to InventoryRecord[]. One record per location when
// levels exist, otherwise one record with the variant-level quantity.
export async function fetchInventory(client: ShopifyClient, source: string): Promise<InventoryRecord[]> {
  const records: InventoryRecord[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();

  for (;;) {
    const variables: Record<string, unknown> = cursor === null ? {} : { cursor };
    const data = await client.graphql<SnapshotResponse>(INVENTORY_SNAPSHOT_QUERY, variables);

    const followingCursor: string | null = nextCursor(data.productVariants, seen, `${source}, productVariants`, cursor !== null);

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

      let levels: InventoryLevelNode[] = [];
      if (variant.inventoryItem) {
        const item = variant.inventoryItem;
        const levelCursor = nextCursor(item.inventoryLevels, new Set(), `${source}, SKU ${sku} inventoryLevels`, false);
        levels = item.inventoryLevels.nodes;
        if (levelCursor !== null) {
          if (!item.id) throw new Error(`Incomplete Shopify snapshot (${source}, SKU ${sku}): missing inventory item id`);
          levels = await fetchRemainingLevels(client, item.id, levelCursor, levels, source);
        }
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

    if (followingCursor === null) break;
    cursor = followingCursor;
  }

  return records;
}
