# Changelog

## 0.5.1 — 2026-11-04

Compatibility and reliability fixes for live Shopify/WooCommerce runs. No
public API or CLI flag changes.

### Fixed

- **Shopify snapshot query cost.** The main inventory query requested
  `productVariants(first: 250)` with nested `inventoryLevels(first: 20)`.
  Shopify multiplies nested connection costs and caps a single Admin GraphQL
  query, so that shape could be rejected before any data was returned. The page
  sizes are now 50 variants × 10 levels; variants with more locations still use
  the explicit cursor page. Verify the effective cost against a real store
  before raising either number.
- **`nightly-zero` could go blind after an earlier zero.** The rule required
  every earlier snapshot in the loaded window to be positive, so a SKU that had
  sold out once in the previous 30 days never triggered again. The immediately
  preceding snapshot is now the stability anchor, with at least one other
  positive earlier snapshot required; a SKU that was already zero yesterday
  still stays silent.
- **Transient 5xx responses are retried.** Shopify and WooCommerce clients now
  back off and retry HTTP 5xx (gateway/overload/deploy) like a 429, instead of
  failing the entire daily run on one response.
- **GitHub Action default version.** `action.yml` defaults to the `latest`
  dist-tag, but the input validator accepted only exact semver and rejected its
  own default. It now accepts published dist-tags such as `latest` and `next`
  while still rejecting shell metacharacters.

### Verification

- 353 tests across 25 files.
- `npm run typecheck`, `npm run build`, `npm run check:versions`.