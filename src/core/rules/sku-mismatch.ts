import type { Finding, InventoryRecord } from '../types.js';
import { normalizeSku } from '../normalize.js';
import { distinctSources, groupByCanonicalSku, groupBySkuLocation, sourcePairs } from '../match.js';

// R1 — cross-source SKU mapping diagnostics:
//   case-only mismatch, whitespace/invisible mismatch, prefix/suffix variants,
//   orphan SKUs, and one-to-many duplicates inside a single source.
//
// One-to-many is bucketed by (sku, location): a SKU stocked at two locations
// legitimately has two rows with different quantities — that is NOT a
// duplicate. Only same-(sku, location) repeats with differing quantities fire.

export function skuMismatch(records: InventoryRecord[]): Finding[] {
  const findings: Finding[] = [];

  // One-to-many duplicates within each single source, per (sku, location).
  // Checked once per source (not per source pair): a three-source diff must
  // not report the same duplicate once per pair it appears in, and a
  // single-source run still deserves the check.
  for (const source of distinctSources(records)) {
    const grouped = groupBySkuLocation(records, source);
    for (const bucket of grouped.values()) {
      if (bucket.records.length < 2) continue;
      const quantities = new Set(bucket.records.map((r) => r.quantityRaw));
      if (quantities.size < 2) continue;
      const rawSku = bucket.records[0]?.sku ?? bucket.canonical;
      const where = bucket.location !== null ? ` at location "${bucket.location}"` : '';
      findings.push({
        rule: 'sku-mismatch',
        severity: 'critical',
        sku: rawSku,
        message: `SKU "${rawSku}" appears ${bucket.records.length} times${where} in ${source} with different quantities`,
        detail: {
          source,
          location: bucket.location,
          occurrences: bucket.records.map((r) => ({
            sku: r.sku,
            location: r.location,
            quantity: r.quantity,
            quantityRaw: r.quantityRaw,
          })),
        },
        suggestion: `Deduplicate "${rawSku}"${where} in ${source}: verify whether rows represent distinct variants, batches or quantity dimensions before consolidating them.`,
      });
    }
  }

  for (const [a, b] of sourcePairs(records)) {
    const mapA = groupByCanonicalSku(records, a);
    const mapB = groupByCanonicalSku(records, b);

    const orphansA: string[] = [];
    const orphansB: string[] = [];

    for (const [canonical, bucketA] of mapA) {
      const bucketB = mapB.get(canonical);
      if (!bucketB) {
        orphansA.push(canonical);
        continue;
      }
      const rawA = bucketA.records[0]?.sku ?? canonical;
      const rawB = bucketB.records[0]?.sku ?? canonical;
      if (rawA === rawB) continue;
      const normA = normalizeSku(rawA);
      const normB = normalizeSku(rawB);
      if (normA.trimmed === normB.trimmed) {
        findings.push({
          rule: 'sku-mismatch',
          severity: 'warning',
          sku: rawA,
          message: `SKU matches only after removing whitespace/invisible characters: "${visible(rawA)}" (${a}) vs "${visible(rawB)}" (${b})`,
          detail: { sourceA: a, sourceB: b, rawA, rawB, kind: 'whitespace' },
          suggestion: 'Confirm both records identify the same item and check matching rules before standardizing whitespace.',
        });
      } else {
        findings.push({
          rule: 'sku-mismatch',
          severity: 'warning',
          sku: rawA,
          message: `SKU differs only by letter case: "${rawA}" (${a}) vs "${rawB}" (${b})`,
          detail: { sourceA: a, sourceB: b, rawA, rawB, kind: 'case' },
          suggestion: 'Check whether the sync tool matches case-sensitively and confirm product identity before standardizing SKU casing.',
        });
      }
    }

    for (const canonical of mapB.keys()) {
      if (!mapA.has(canonical)) orphansB.push(canonical);
    }

    const { pairs, remainingA, usedB } = pairPrefixSuffixVariants(orphansA, orphansB);
    for (const [canonicalA, canonicalB] of pairs) {
      const rawA = mapA.get(canonicalA)?.records[0]?.sku ?? canonicalA;
      const rawB = mapB.get(canonicalB)?.records[0]?.sku ?? canonicalB;
      findings.push({
        rule: 'sku-mismatch',
        severity: 'info',
        sku: rawA,
        message: `Possible prefix/suffix variant: "${rawA}" (${a}) vs "${rawB}" (${b})`,
        detail: { sourceA: a, sourceB: b, rawA, rawB, kind: 'prefix-suffix' },
        suggestion: 'If these are the same product, configure your sync tool to strip the prefix/suffix, or rename one SKU.',
      });
    }

    for (const canonical of remainingA) {
      const raw = mapA.get(canonical)?.records[0]?.sku ?? canonical;
      findings.push({
        rule: 'sku-mismatch',
        severity: 'warning',
        sku: raw,
        message: `SKU "${raw}" is present in the supplied ${a} records but absent from the supplied ${b} records`,
        detail: { sourceA: a, sourceB: b, presentIn: a, missingFrom: b, kind: 'orphan' },
        suggestion: 'Check catalog scope, export filters and SKU aliases; add or map the item only if both sources should contain it.',
      });
    }
    for (const canonical of orphansB) {
      if (usedB.has(canonical)) continue;
      const raw = mapB.get(canonical)?.records[0]?.sku ?? canonical;
      findings.push({
        rule: 'sku-mismatch',
        severity: 'warning',
        sku: raw,
        message: `SKU "${raw}" is present in the supplied ${b} records but absent from the supplied ${a} records`,
        detail: { sourceA: a, sourceB: b, presentIn: b, missingFrom: a, kind: 'orphan' },
        suggestion: 'Check catalog scope, export filters and SKU aliases; add or map the item only if both sources should contain it.',
      });
    }
  }

  return findings.map((f) => ({
    ...f,
    evidence: [f.message],
    risk: f.detail['kind'] === 'orphan'
      ? 'If both catalogs should contain this item, its absence from the supplied records may prevent matching; intentional assortment or export scope differences can explain it.'
      : 'If the records identify the same item and the sync tool cannot resolve these identifiers or repeated rows, inventory updates may be missed or applied incorrectly.',
    assumptions: ['Catalog overlap, product identity and matching behavior have not been verified; string similarity alone does not establish product identity.'],
    verification: ['Check product/variant identifiers, barcode reuse, catalog scope, export filters and actual sync matching rules before renaming, adding or removing records.'],
  }));
}

const MIN_AFFIX_LENGTH = 2;

// A pair qualifies only when the shorter string is a STRICT prefix or STRICT
// suffix of the longer one and the differing affix is at least
// MIN_AFFIX_LENGTH chars. "a-1" vs "a-11" (affix "1") does not qualify;
// "abc-123" vs "shop-abc-123" (affix "shop-") does.
export function isPrefixSuffixPair(shorter: string, longer: string): boolean {
  if (shorter.length === 0 || longer.length <= shorter.length) return false;
  if (longer.length - shorter.length < MIN_AFFIX_LENGTH) return false;
  return longer.startsWith(shorter) || longer.endsWith(shorter);
}

// Match orphan SKUs across sources without O(n²) all-pairs comparison:
// candidates are bucketed by length and only lengths leaving room for a
// ≥ MIN_AFFIX_LENGTH affix are probed (startsWith/endsWith, both directions).
export function pairPrefixSuffixVariants(
  orphansA: string[],
  orphansB: string[],
): { pairs: Array<[string, string]>; remainingA: string[]; usedB: Set<string> } {
  const byLengthB = new Map<number, string[]>();
  for (const b of orphansB) {
    const list = byLengthB.get(b.length) ?? [];
    list.push(b);
    byLengthB.set(b.length, list);
  }
  const sortedLengths = [...byLengthB.keys()].sort((x, y) => x - y);

  const pairs: Array<[string, string]> = [];
  const remainingA: string[] = [];
  const usedB = new Set<string>();

  for (const a of orphansA) {
    let partner: string | null = null;
    for (const len of sortedLengths) {
      if (Math.abs(len - a.length) < MIN_AFFIX_LENGTH) continue;
      for (const b of byLengthB.get(len) ?? []) {
        if (usedB.has(b)) continue;
        const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
        if (isPrefixSuffixPair(shorter, longer)) {
          partner = b;
          break;
        }
      }
      if (partner !== null) break;
    }
    if (partner !== null) {
      usedB.add(partner);
      pairs.push([a, partner]);
    } else {
      remainingA.push(a);
    }
  }

  return { pairs, remainingA, usedB };
}

function visible(raw: string): string {
  return raw
    .replace(/ /g, '[sp]')
    .replace(/\u3000/g, '[sp]')
    .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060\uFEFF]/g, '[zw]');
}
