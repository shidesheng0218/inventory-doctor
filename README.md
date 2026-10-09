# inventory-doctor

Multi-source inventory sync diagnostics — **find the SKUs you're overselling without knowing it.**

Compare two inventory snapshots (CSV exports or live Shopify stores) and get a report of everything that doesn't line up: SKU mismatches, oversell risk, blank cells masquerading as zeros, barcode conflicts, and more.

**Your data never leaves your machine.** CSV files are parsed locally; Shopify API calls go directly from your computer to your own stores over HTTPS. There is no server, no telemetry, no upload.

**Not a sync tool — an auditor for sync tools.** Trunk, Syncio, Synkro and friends *write* to your inventory (and their own reviews show they sometimes get it wrong). inventory-doctor never writes anything: it is the independent, read-only reconciliation layer you run alongside whatever sync app you use. See [docs/competitive-analysis.md](docs/competitive-analysis.md) for the full comparison.

**Built for agentic commerce.** AI-buyer traffic is growing fast — agent-initiated store visits are up ~393% year over year — and AI buyers are cancellation-intolerant: one oversell is a failed order and a merchant record that buying agents learn to avoid, not a disappointed human who might come back. Meanwhile every sync engine in your stack is *writing* to your inventory around the clock. Every sync-app user needs an independent audit layer, and inventory-doctor is the read-only reconciliation layer built to be exactly that. See [docs/competitive-analysis.md](docs/competitive-analysis.md) for the full landscape.

## Who this is for

* **Developers and agencies** run the engine directly: the CLI and the MCP
  server are the whole diagnostic core, MIT, no account, no service in the
  middle. Wire `snapshot save` + `snapshot check` into your own cron or CI and you
  own the schedule.
* **Merchants and teams who would rather not run infrastructure** get the
  same engine behind a hosted app (in development): it schedules the daily
  check, keeps the history, compares the store against a 3PL/ERP export, and
  alerts when something breaks.

The split is deliberate and one-way: the engine stays open so you can audit
exactly what is being judged and run it yourself; the hosted app adds the
boring parts (scheduling, storage, alerting, multi-source plumbing).

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

## Fix export — from finding to fix

`--fix-export` turns critical findings into a Shopify-importable inventory CSV that brings the **second** source in line with the **first** (the source of truth):

```bash
inventory-doctor diff a.csv b.csv --fix-export fix.csv
# → fix direction: bring "b" in line with "a" (first source = source of truth)
# → review fix.csv, verify it, then import it into b
```

**Watch the direction.** With mixed flags the "first" source is not necessarily the first flag you typed — precedence is: positional files, then `--csv`, then `--store`/`--woo`, then `--baseline`. The run always prints the direction before writing, so check that line.

The tool never writes to any API. The fix is a file you can read, diff, and re-check before importing — the run prints the exact verify command (`inventory-doctor diff <truth-source> fix.csv`), so you can prove the fix would heal the report first. An auditable fix, not a silent mutation. Critical findings that an inventory import cannot fix (e.g. a SKU missing from the target entirely) are called out explicitly instead of being silently dropped.

## Snapshots — time-series diagnosis

A single diff compares two snapshots taken now. Saving snapshots over time unlocks the time-series rule (`nightly-zero`): "this SKU was in stock every day and suddenly reads 0" — the silent-wipe pattern a one-off diff cannot see.

```bash
inventory-doctor snapshot save store-a.csv            # or: --store store-a via snapshot save store:store-a
inventory-doctor snapshot list shopify-store-a
inventory-doctor snapshot check shopify-store-a       # needs ≥3 snapshots; exit 1 on critical

inventory-doctor diff now.csv --baseline shopify-store-a          # latest snapshot
inventory-doctor diff now.csv --baseline shopify-store-a@2026-09-01  # a specific one
```

Alert when the check catches something critical — the check POSTs a JSON summary
and still exits 1, whether or not the alert went through:

```bash
inventory-doctor snapshot check shopify-store-a --webhook https://hooks.slack.com/your-endpoint
```

```json
{ "name": "shopify-store-a", "critical": 1, "warning": 0,
  "findings": [{ "severity": "critical", "message": "\"SKU-1\" was stocked across 2 snapshots … but reads 0 in the latest" }] }
```

Only critical findings alert — a warning-only history stays silent, so the
endpoint doesn't fatigue you into ignoring it. A failed send (network error,
non-2xx) is a stderr warning and never changes the exit code. Set a default in
`inventory-doctor.json` and the flag wins per-run:

```json
{ "stores": [ … ], "notify": { "webhookUrl": "https://hooks.slack.com/your-endpoint" } }
```

Snapshots live as local JSONL files under `~/.local/share/inventory-doctor/snapshots/<name>/` (override
with `INVENTORY_DOCTOR_SNAPSHOT_DIR`). Put `snapshot save` + `snapshot check` on a cron and
you have daily reconciliation with no service in the middle and no account.

Keep as much history as you like, but give the check a window — it only needs
the recent past, and every loaded record costs memory (~300 bytes, measured):

```bash
inventory-doctor snapshot check shopify-store-a --window 30
```

A year of daily snapshots of a 5,000-SKU shop is ~0.5 GB on disk; loading all
of it would need ~510 MB of RAM. With `--window 30` the run stays around 45 MB
however long the history grows. The listing is cheap either way — only the
snapshots inside the window are read.

## GitHub Action

Run a diff in CI with the composite action from this repo (published to the
marketplace):

```yaml
- uses: shidesheng0218/inventory-doctor@v0.3.0
  with:
    source-a: exports/store-a.csv        # or store:<name> / snapshot:<name>
    source-b: exports/store-b.csv
    # config: path/to/inventory-doctor.json   # only if not in a default location
    # format: terminal                       # terminal | markdown | html
    # extra-args: --drift-abs 5              # any extra CLI flags
```

`source-a` and `source-b` are required; everything else is optional.
Credentials referenced as `"env:VAR_NAME"` in `inventory-doctor.json` are read
from the step environment — set them as env vars in your calling workflow
(composite actions cannot reference the `secrets` context themselves), e.g.
at job level:

```yaml
env:
  STORE_A_TOKEN: ${{ secrets.STORE_A_TOKEN }}   # also STORE_B_CLIENT_ID,
  STORE_B_SECRET: ${{ secrets.STORE_B_SECRET }} # STORE_B_SECRET, WOO_CK,
  WOO_CK: ${{ secrets.WOO_CK }}                 # WOO_CS, SHOPIFY_CLIENT_SECRET
  WOO_CS: ${{ secrets.WOO_CS }}
  SHOPIFY_CLIENT_SECRET: ${{ secrets.SHOPIFY_CLIENT_SECRET }}
```

The report is written to `inventory-doctor-report.txt` and uploaded as an
artifact; the file path is also exposed as the `report` output. When critical
findings exist the CLI exits 1 and the step — and therefore the job — goes
red. Set `fail-on-critical: 'false'` to keep the workflow green and only
collect the report. See `.github/workflows/example-inventory-check.yml` for a
self-contained run (it diffs this repo's fixtures nightly, with
`fail-on-critical: false` since the fixtures intentionally contain criticals).

## The nine diagnostic rules

| Rule | What it catches | Severity |
| --- | --- | --- |
| `sku-mismatch` | Case-only / whitespace / prefix-suffix SKU variants, orphan SKUs, one-to-many duplicates within one source | info → critical |
| `oversell-risk` | Quantity ≤ 0 on one side but > 0 on the other; "continue selling when out of stock" with empty stock; drift beyond threshold | warning → critical |
| `oversold` | Negative available quantity — orders already accepted for stock that does not exist. Needs no second source, so a single store gets this on day one | critical |
| `blank-vs-zero` | A **blank** quantity cell vs an explicit `0` — the classic "bulk import wiped my inventory" root cause | critical |
| `barcode-crosscheck` | Same barcode, different SKUs across sources — silent mapping misconfiguration | critical |
| `quantity-drift` | Overall sync health: % exact / minor drift / severe drift / unmatched → health score 0–100 | info |
| `untracked` | Inventory tracking disabled in one source while another manages stock | info |
| `nightly-zero` | Time-series across saved snapshots: a SKU with a stable positive history suddenly reading 0 ("silently zeroed overnight"), vanishing, or dropping suspiciously fast | warning → critical |
| `bundle-availability` | A bundle (kit) listed sellable while its components can no longer support even one assembly; listed bundle qty drifting from what component stock supports; component missing from a source | warning → critical |

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

The same file can tune the diagnostic rules (all optional; CLI flags win over these):

```jsonc
{
  "rules": {
    "disable": ["untracked"],                     // turn a rule off entirely
    "ignoreSkus": ["GIFT-*", "TEST-?"],           // glob vs canonical SKU — findings dropped
    "severityOverrides": { "blank-vs-zero": "warning" },
    "driftAbsThreshold": 10,                      // like --drift-abs
    "driftPctThreshold": 0.3                      // like --drift-pct
  },
  // Bundle kits for the bundle-availability rule (top level, not under "rules").
  // computedMax = min over components of floor(componentQty / required), per source/location.
  "bundles": [
    { "sku": "GIFT-KIT", "components": [{ "sku": "KIT-A", "quantity": 1 }, { "sku": "KIT-B", "quantity": 2 }] }
  ]
}
```

Details that matter:

- API version pinned to **2026-07** (`/admin/api/2026-07/graphql.json`).
- Inventory is read via `quantities(names: [...])` — the old `InventoryLevel.available` field no longer exists.
- Tokens from client credentials live 24h; they're cached and refreshed 60s early, not re-requested per call.
- Every HTTP request has a 30s timeout, and transient network failures (reset, DNS, timeout) are retried with the same 1s backoff as rate limits — a hung store cannot hang the run.
- Rate limiting is **adaptive**: every response's `extensions.cost.throttleStatus.currentlyAvailable` drives a slow-down before the bucket empties; HTTP 429 / `THROTTLED` backs off 1s and retries. No plan-specific rate numbers are hardcoded.
- Read-only scopes only: `read_inventory`, `read_products`, `read_locations`.

**Client credentials limitation:** the app and the store must belong to the **same Shopify org**. That covers "a merchant building a tool for their own store". Agencies managing client stores get `shop_not_permitted` from client credentials — use the OAuth flow below instead.

## Shopify OAuth (agency / cross-org)

One-time browser flow per store. Prerequisite: a Dev Dashboard app with a loopback redirect URL (`http://127.0.0.1`) registered — see Shopify's OAuth docs.

```bash
inventory-doctor auth client-store.myshopify.com --client-id ... --client-secret ...
```

This opens the consent screen, exchanges the code for an **offline token** (never expires), and saves it to `~/.config/inventory-doctor/oauth-tokens.json` (mode 0600) — not to your project config. Then reference it with `"oauth": true`:

```jsonc
{ "name": "client-store", "domain": "client-store.myshopify.com", "oauth": true }
```

## WooCommerce (REST API)

Add a `woocommerce` section to `inventory-doctor.json` (consumer key/secret from WooCommerce → Settings → Advanced → REST API):

```jsonc
{
  "woocommerce": [
    { "name": "woo-shop", "baseUrl": "https://shop.example.com",
      "consumerKey": "env:WOO_CK", "consumerSecret": "env:WOO_CS" }
  ]
}
```

Then `woo:<name>` works everywhere a source is accepted:

```bash
inventory-doctor diff --store store-a --woo woo-shop   # Shopify vs WooCommerce
inventory-doctor diff woo-shop-export.csv --woo woo-shop
```

Notes: HTTPS is enforced (Basic Auth over plain HTTP would leak credentials). `manage_stock: false` maps to "tracking off" (the `untracked` rule fires as usual), and `backorders: yes/notify` maps to "continue selling when out of stock". WooCommerce core has no multi-location inventory, so Woo sources have no location dimension.

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

- `diff_inventory(sourceA, sourceB, configPath?, maxFindings?)` — full diagnosis, returns the JSON report. Findings are capped at `maxFindings` (default 100) so a large catalog cannot flood the agent's context; on truncation the payload carries `totalFindings` and points at `explain_sku` for the remainder.
- `explain_sku(sku, sources, configPath?)` — one SKU's raw values and findings across all sources (for follow-up questions)
- `inventory_health(sources, configPath?)` — lightweight health-score summary

Every source argument accepts either a **CSV file path**, **`store:<name>`** (a store from `inventory-doctor.json`, credentials resolved from env vars), or **`snapshot:<name>[@<id>]`** (a saved snapshot) — so an agent can diff two live stores, or a store against a CSV, in one call. `configPath` is only needed when the config file is not in a default location.

stdout is reserved for JSON-RPC; all logging goes to stderr.

## Honest limitations

- **Time-series needs saved snapshots.** `snapshot check` detects silent zeroing across history, but only over snapshots you actually saved — it cannot reconstruct the past before the first save.
- **WooCommerce has no multi-location inventory** in core; per-location diagnosis on that side needs a CSV export from a multi-location plugin instead.
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
