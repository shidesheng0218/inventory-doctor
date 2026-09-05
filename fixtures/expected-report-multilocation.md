# Inventory Doctor Report

**Sources:** `shopify-inventory-c` vs `shopify-inventory-d`

| Source | Records |
| --- | ---: |
| `shopify-inventory-c` | 7 |
| `shopify-inventory-d` | 7 |

## Sync health score: 71/100

| Exact match | Minor drift | Severe drift | Unmatched | Total compared |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 0 | 2 | 0 | 7 |

## Critical (2)

- **[oversell-risk]** "MULTI-2" quantity differs by 8 (40%) at location "Warehouse A": 20 in shopify-inventory-c vs 12 in shopify-inventory-d
  - Suggestion: Reconcile the count in the source of truth and re-sync; investigate recent orders/restocks that only one side recorded.
- **[oversell-risk]** "MULTI-3" is out of stock in shopify-inventory-c (0) at location "Warehouse A" but shows 6 available in shopify-inventory-d — you may be selling stock you don't have
  - Suggestion: Push the real quantity from shopify-inventory-d to shopify-inventory-c, or pause the listing in shopify-inventory-c.

## Info (1)

- **[quantity-drift]** Sync health score: 71/100 — 5 exact, 0 minor drift, 2 severe drift, 0 unmatched of 7 SKUs compared
  - Suggestion: Fix severe drift and orphan SKUs first; they are where oversells and lost sales live.

