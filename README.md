# inventory-doctor

Multi-source inventory sync diagnostics — **find the SKUs you're overselling without knowing it.**

Compare two inventory snapshots (CSV exports or live Shopify stores) and get a report of everything that doesn't line up: SKU mismatches, oversell risk, blank cells masquerading as zeros, barcode conflicts, and more.

**Your data never leaves your machine.** CSV files are parsed locally; Shopify API calls go directly from your computer to your own stores over HTTPS. There is no server, no telemetry, no upload.

## Install & run

```bash
npm install          # or: pnpm install
npm run build        # produces dist/cli.js (with shebang)

# zero-credential path: two CSV exports
npx tsx src/cli.ts diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv
# or after build / npm link:
inventory-doctor diff a.csv b.csv
```

## What it looks like

Running `inventory-doctor diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv` against the bundled sample files (which deliberately contain one of every problem):

```
inventory-doctor — sync diagnosis
============================================================
Sources: shopify-store-a  vs  shopify-store-b
  shopify-store-a: 13 records
  shopify-store-b: 12 records

Sync health score: 33/100
  exact match: 5 · minor drift: 0 · severe drift: 4 · unmatched: 6 (of 15)

CRITICAL (8)
------------------------------------------------------------
[CRITICAL] SKU "DUP-100" appears 2 times in shopify-store-a with different quantities
[CRITICAL] SKU "ORPHAN-A" exists in shopify-store-a but is missing from shopify-store-b
[CRITICAL] "OVER-1" is out of stock in shopify-store-a (0) but shows 8 available in
           shopify-store-b — you may be selling stock you don't have
[CRITICAL] "BLANK-1" has a BLANK quantity cell in shopify-store-a (not "0") while
           shopify-store-b tracks a real quantity — an import may read this as 0
[CRITICAL] Barcode 9999999 maps to 2 different SKUs across sources
           ("BC-A" in shopify-store-a vs "BC-B" in shopify-store-b)
...

WARNING (5)
------------------------------------------------------------
[WARN]     SKU differs only by letter case: "ABC-123" (a) vs "abc-123" (b)
[WARN]     SKU matches only after removing whitespace/invisible characters
[WARN]     "CONT-1" allows overselling ("continue selling when out of stock") with quantity 0
...

INFO (3)
------------------------------------------------------------
[INFO]     Possible prefix/suffix variant: "GHI-789" (a) vs "SHOP-GHI-789" (b)
[INFO]     Sync health score: 33/100 — 5 exact, 0 minor drift, 4 severe drift, 6 unmatched
[INFO]     "UNTRACKED-1" has inventory tracking OFF in shopify-store-a but is
           stock-managed in shopify-store-b
```

The full output is checked in as [`fixtures/expected-report.md`](fixtures/expected-report.md) — it's a living document verified by the test suite.

The exit code is `1` when critical findings exist, so you can wire this into CI or a cron job.

## The six diagnostic rules

| Rule | What it catches | Severity |
| --- | --- | --- |
| `sku-mismatch` | Case-only / whitespace / prefix-suffix SKU variants, orphan SKUs, one-to-many duplicates within one source | info → critical |
| `oversell-risk` | Quantity ≤ 0 on one side but > 0 on the other; "continue selling when out of stock" with empty stock; drift beyond threshold | warning → critical |
| `blank-vs-zero` | A **blank** quantity cell vs an explicit `0` — the classic "bulk import wiped my inventory" root cause | critical |
| `barcode-crosscheck` | Same barcode, different SKUs across sources — silent mapping misconfiguration | critical |
| `quantity-drift` | Overall sync health: % exact / minor drift / severe drift / unmatched → health score 0–100 | info |
| `untracked` | Inventory tracking disabled in one source while another manages stock | info |

**Blank vs "0" is a first-class distinction.** CSV parsers love turning empty cells into 0; this tool keeps `quantity: null` strictly separate from `quantity: 0` all the way through.

## Supported inputs

- **Shopify product CSV** — both header generations are recognized (`Variant SKU` *and* the current `SKU`, `Variant Inventory Qty` *and* `Inventory quantity`, etc.)
- **Shopify inventory CSV** — both layouts: the long "All states" table (one row per variant × location) and the wide "Available" table (location names as column headers, inferred automatically)
- **Anything else** — alias-based column probing (Amazon-style `seller-sku`/`quantity` TSVs work out of the box), plus explicit mapping when guessing fails:

```bash
inventory-doctor diff shopify.csv erp.csv --map sku="Item Code" --map quantity="Stock Count"
```

SKU normalization (trim, case folding, full-width → half-width, zero-width character removal) is used **only for comparison** — reports always show your raw SKU values.

**Multi-location aware.** When both sources carry a location dimension (inventory CSV long/wide, or the API), quantities are compared per (SKU, location): a location-level stockout or drift is reported at that location and never hidden by summing across locations, and a SKU stocked at two locations is *not* mistaken for a duplicate. When one side has no location dimension (product CSV), its per-SKU quantity is compared against the other side's cross-location sum. See `fixtures/shopify-inventory-c.csv` / `-d.csv` (long format) and `fixtures/shopify-inventory-wide-e.csv` / `-f.csv` (wide format) for worked examples.

## Shopify Admin API (optional)

Pull live snapshots instead of exporting CSVs. Create `inventory-doctor.json` in the project directory (or `~/.config/inventory-doctor/config.json`):

```jsonc
{
  "stores": [
    // Mode 1: existing static token (shpat_... — still works if you already have one)
    { "name": "store-a", "domain": "a.myshopify.com", "accessToken": "env:STORE_A_TOKEN" },
    // Mode 2: client credentials grant (the current way to create app credentials)
    { "name": "store-b", "domain": "b.myshopify.com",
      "clientId": "env:STORE_B_CLIENT_ID", "clientSecret": "env:STORE_B_SECRET" }
  ]
}
```

Credentials support `"env:VAR_NAME"` references so secrets stay out of files. Then:

```bash
inventory-doctor diff --store store-a --store store-b   # store vs store
inventory-doctor diff --store store-a --csv b.csv       # mixed mode
```

Details that matter:

- API version pinned to **2026-07** (`/admin/api/2026-07/graphql.json`).
- Inventory is read via `quantities(names: [...])` — the old `InventoryLevel.available` field no longer exists.
- Tokens from client credentials live 24h; they're cached and refreshed 60s early, not re-requested per call.
- Rate limiting is **adaptive**: every response's `extensions.cost.throttleStatus.currentlyAvailable` drives a slow-down before the bucket empties; HTTP 429 / `THROTTLED` backs off 1s and retries. No plan-specific rate numbers are hardcoded.
- Read-only scopes only: `read_inventory`, `read_products`, `read_locations`.

**Client credentials limitation:** the app and the store must belong to the **same Shopify org**. That covers "a merchant building a tool for their own store". Agencies managing client stores will get `shop_not_permitted` and need full OAuth — which this tool does **not** implement (v1).

## MCP server (use it from Claude Code and other agents)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "inventory-doctor": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "inventory-doctor", "mcp"],
      "env": { "SHOPIFY_CLIENT_SECRET": "${SHOPIFY_CLIENT_SECRET}" }
    }
  }
}
```

Three tools are registered:

- `diff_inventory(sourceA, sourceB, configPath?)` — full diagnosis, returns the JSON report
- `explain_sku(sku, sources, configPath?)` — one SKU's raw values and findings across all sources (for follow-up questions)
- `inventory_health(sources, configPath?)` — lightweight health-score summary

Every source argument accepts either a **CSV file path** or **`store:<name>`** (a store from `inventory-doctor.json`, credentials resolved from env vars) — so an agent can diff two live stores, or a store against a CSV, in one call. `configPath` is only needed when the config file is not in a default location.

stdout is reserved for JSON-RPC; all logging goes to stderr.

## Honest limitations

- **Snapshot diffing only.** This compares two snapshots taken now. It does **not** do time-series detection (e.g. "this SKU gets silently zeroed every night") — that needs snapshot history and is planned for v2.
- **Client credentials = same org only**, as described above. No OAuth flow in v1.
- Amazon report headers vary by marketplace and report options; detection is best-effort via column aliases, and `--map` is the escape hatch.
- Product CSVs carry no per-location inventory; multi-location diagnosis needs the inventory CSV export or the API.

## Development

```bash
npm test             # vitest — rules, CSV adapters, token cache, throttle logic
npm run dev -- diff fixtures/shopify-store-a.csv fixtures/shopify-store-b.csv
npm run build        # tsc + shebang
npm run check:stdout # guards the MCP stdout discipline
```

Architecture: `src/core/` is a pure-function diagnostic kernel (`(records: InventoryRecord[]) => Finding[]`, zero I/O); `src/adapters/` turn CSVs and the Shopify API into that intermediate representation; CLI and MCP layers only parse arguments and format output. Adding a new source (WooCommerce, BigCommerce, …) means adding one adapter, no refactor.
