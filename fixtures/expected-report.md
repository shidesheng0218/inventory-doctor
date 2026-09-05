# Inventory Doctor Report

**Sources:** `shopify-store-a` vs `shopify-store-b`

| Source | Records |
| --- | ---: |
| `shopify-store-a` | 13 |
| `shopify-store-b` | 12 |

## Sync health score: 33/100

| Exact match | Minor drift | Severe drift | Unmatched | Total compared |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 0 | 4 | 6 | 15 |

## Critical (8)

- **[sku-mismatch]** SKU "DUP-100" appears 2 times in shopify-store-a with different quantities
  - Suggestion: Deduplicate "DUP-100" in shopify-store-a: one SKU should map to exactly one quantity per location.
- **[sku-mismatch]** SKU "ORPHAN-A" exists in shopify-store-a but is missing from shopify-store-b
  - Suggestion: Add "ORPHAN-A" to shopify-store-b or archive it in shopify-store-a — it can never be kept in sync as-is.
- **[sku-mismatch]** SKU "BC-A" exists in shopify-store-a but is missing from shopify-store-b
  - Suggestion: Add "BC-A" to shopify-store-b or archive it in shopify-store-a — it can never be kept in sync as-is.
- **[sku-mismatch]** SKU "ORPHAN-B" exists in shopify-store-b but is missing from shopify-store-a
  - Suggestion: Add "ORPHAN-B" to shopify-store-a or archive it in shopify-store-b — it can never be kept in sync as-is.
- **[sku-mismatch]** SKU "BC-B" exists in shopify-store-b but is missing from shopify-store-a
  - Suggestion: Add "BC-B" to shopify-store-a or archive it in shopify-store-b — it can never be kept in sync as-is.
- **[oversell-risk]** "OVER-1" is out of stock in shopify-store-a (0) but shows 8 available in shopify-store-b — you may be selling stock you don't have
  - Suggestion: Push the real quantity from shopify-store-b to shopify-store-a, or pause the listing in shopify-store-a.
- **[blank-vs-zero]** "BLANK-1" has a BLANK quantity cell in shopify-store-a (not "0") while shopify-store-b tracks a real quantity — an import may read this as 0 and wipe the stock
  - Suggestion: Write an explicit "0" if the item is truly out of stock, or fill in the real quantity. Never leave quantity cells blank before a bulk import.
- **[barcode-crosscheck]** Barcode 9999999 maps to 2 different SKUs across sources ("BC-A" in shopify-store-a vs "BC-B" in shopify-store-b) — the SKU mapping is likely misconfigured
  - Suggestion: These records share one barcode, so they are almost certainly the same product. Align the SKU in all sources, or fix the barcode on the wrong record.

## Warning (5)

- **[sku-mismatch]** SKU differs only by letter case: "ABC-123" (shopify-store-a) vs "abc-123" (shopify-store-b)
  - Suggestion: Unify SKU casing across sources — many sync tools treat SKUs case-sensitively.
- **[sku-mismatch]** SKU matches only after removing whitespace/invisible characters: "DEF-456" (shopify-store-a) vs "DEF-456[sp]" (shopify-store-b)
  - Suggestion: Trim leading/trailing whitespace and remove zero-width characters; make the raw SKU identical in both sources.
- **[oversell-risk]** "DUP-100" quantity differs by 4 (31%): 13 in shopify-store-a vs 9 in shopify-store-b
  - Suggestion: Reconcile the count in the source of truth and re-sync; investigate recent orders/restocks that only one side recorded.
- **[oversell-risk]** "DRIFT-1" quantity differs by 8 (8%): 100 in shopify-store-a vs 92 in shopify-store-b
  - Suggestion: Reconcile the count in the source of truth and re-sync; investigate recent orders/restocks that only one side recorded.
- **[oversell-risk]** "CONT-1" in shopify-store-a allows overselling ("continue selling when out of stock") with quantity 0
  - Suggestion: Confirm this oversell setting is intentional, and make sure the other source does not also count this stock.

## Info (3)

- **[sku-mismatch]** Possible prefix/suffix variant: "GHI-789" (shopify-store-a) vs "SHOP-GHI-789" (shopify-store-b)
  - Suggestion: If these are the same product, configure your sync tool to strip the prefix/suffix, or rename one SKU.
- **[quantity-drift]** Sync health score: 33/100 — 5 exact, 0 minor drift, 4 severe drift, 6 unmatched of 15 SKUs compared
  - Suggestion: Fix severe drift and orphan SKUs first; they are where oversells and lost sales live.
- **[untracked]** "UNTRACKED-1" has inventory tracking OFF in shopify-store-a but is stock-managed in shopify-store-b
  - Suggestion: Enable inventory tracking for "UNTRACKED-1" in shopify-store-a, otherwise its quantity will never decrement and sync will silently drift.

