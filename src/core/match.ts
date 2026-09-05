import type { InventoryRecord } from './types.js';
import { normalizeSku } from './normalize.js';

export function distinctSources(records: InventoryRecord[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const r of records) {
    if (!seen.has(r.source)) {
      seen.add(r.source);
      order.push(r.source);
    }
  }
  return order;
}

export function sourcePairs(records: InventoryRecord[]): Array<[string, string]> {
  const sources = distinctSources(records);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      pairs.push([sources[i] as string, sources[j] as string]);
    }
  }
  return pairs;
}

export interface SkuBucket {
  canonical: string;
  records: InventoryRecord[];
}

// Group a single source's records by canonical (normalized) SKU.
// Records with null/empty SKU are excluded from cross-source matching.
export function groupByCanonicalSku(records: InventoryRecord[], source: string): Map<string, SkuBucket> {
  const map = new Map<string, SkuBucket>();
  for (const r of records) {
    if (r.source !== source) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;
    const bucket = map.get(canonical) ?? { canonical, records: [] };
    bucket.records.push(r);
    map.set(canonical, bucket);
  }
  return map;
}

export interface SkuLocationBucket {
  canonical: string;
  location: string | null;
  records: InventoryRecord[];
}

// Location-aware grouping key: a SKU stocked at two locations is two buckets,
// NOT a duplicate. Location values are case-sensitive per Shopify semantics.
export function groupBySkuLocation(records: InventoryRecord[], source: string): Map<string, SkuLocationBucket> {
  const map = new Map<string, SkuLocationBucket>();
  for (const r of records) {
    if (r.source !== source) continue;
    if (r.sku === null) continue;
    const canonical = normalizeSku(r.sku).canonical;
    if (canonical === '') continue;
    const location = r.location === null ? null : r.location.trim();
    const key = canonical + String.fromCharCode(0) + (location ?? '');
    const bucket = map.get(key) ?? { canonical, location, records: [] };
    bucket.records.push(r);
    map.set(key, bucket);
  }
  return map;
}

// Aggregate quantity of a bucket: sum of non-null quantities; null when every
// record is blank (null quantity). A bucket of [null, 2] sums to 2 — the blank
// itself is reported separately by blank-vs-zero.
export function aggregateQuantity(bucket: { records: InventoryRecord[] }): number | null {
  let sum = 0;
  let any = false;
  for (const r of bucket.records) {
    if (r.quantity !== null) {
      sum += r.quantity;
      any = true;
    }
  }
  return any ? sum : null;
}

export function hasLocationDimension(bucket: SkuBucket): boolean {
  return bucket.records.some((r) => r.location !== null && r.location.trim() !== '');
}

// Split a sku-level bucket into per-location quantity buckets. Used when both
// sources carry a location dimension and comparison must be location-aligned.
export function perLocationQuantities(bucket: SkuBucket): Map<string, { quantity: number | null; records: InventoryRecord[] }> {
  const map = new Map<string, { quantity: number | null; records: InventoryRecord[] }>();
  for (const r of bucket.records) {
    const location = r.location === null || r.location.trim() === '' ? '(no location)' : r.location.trim();
    const entry = map.get(location) ?? { quantity: null, records: [] };
    entry.records.push(r);
    if (r.quantity !== null) entry.quantity = (entry.quantity ?? 0) + r.quantity;
    map.set(location, entry);
  }
  return map;
}
