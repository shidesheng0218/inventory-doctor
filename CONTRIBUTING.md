# Contributing

Thanks for looking at inventory-doctor. This is a young, single-maintainer project — small, focused PRs are much easier to review than large ones.

## Setup

```bash
git clone https://github.com/shidesheng0218/inventory-doctor.git
cd inventory-doctor
pnpm install
pnpm test
```

## Before opening a PR

```bash
pnpm test           # vitest — must be green
pnpm typecheck       # tsc --noEmit
pnpm run check:stdout  # no console.log in src/ — stdout is the MCP JSON-RPC channel
pnpm run build        # tsc + shebang, must succeed
```

## Where things live

- `src/core/` — pure diagnostic functions, `(records: InventoryRecord[]) => Finding[]`. No I/O, no platform assumptions. This is the part most worth testing carefully.
- `src/adapters/` — turn a data source (CSV, Shopify API) into `InventoryRecord[]`. Adding a new platform (WooCommerce, BigCommerce, a generic ERP export) means adding one adapter here, not touching `core/`.
- `src/report/` — output formatting only (terminal, JSON, markdown).
- `fixtures/` — sample CSVs used by the README and the e2e test. If you add a new diagnostic case, add it here and keep `fixtures/expected-report.md` in sync — it's checked by the test suite, not just documentation.

## Reporting a bug

Please include:
- The command you ran (or the MCP tool call)
- The relevant CSV header row (redact SKUs/values if needed — column *names* are usually enough to reproduce)
- What you expected vs. what happened

## Adding a diagnostic rule

Rules are pure functions in `src/core/rules/`. A new rule should:
1. Take `InventoryRecord[]` and return `Finding[]` — no side effects.
2. Come with unit tests covering the case it catches and at least one case it should *not* flag.
3. Not claim to detect anything that needs time-series data (multiple snapshots over time) — that's out of scope for v1, see "Honest limitations" in the README.

## Code of conduct

Be respectful and assume good faith. Disagreements about design are fine; personal attacks are not.
