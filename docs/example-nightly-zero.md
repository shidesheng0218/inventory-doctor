# Example: the "silently zeroed overnight" demo (marketing SOP)

This is the reproducible command sequence behind the nightly-zero marketing demo
(screenshots / screen recordings). It simulates three days of snapshot history
for a store, where a SKU that held stable stock on day 1 and day 2 reads **0** on
day 3 — the silent-wipe pattern a one-off diff cannot see. The generated
snapshots are throwaway artifacts: they are **not** committed to the repo.

Run everything from the repository root.

## Setup: throwaway snapshot directory

Snapshots normally live under `~/.local/share/inventory-doctor/snapshots/`.
For the demo, point `INVENTORY_DOCTOR_SNAPSHOT_DIR` at a temp dir so the demo
never touches your real snapshot history:

```bash
cd inventory-doctor   # repository root
DEMO_DIR=$(mktemp -d)
export INVENTORY_DOCTOR_SNAPSHOT_DIR="$DEMO_DIR/snapshots"
```

## Day 1 and day 2: stable history

```bash
cp fixtures/shopify-store-a.csv "$DEMO_DIR/day1.csv"
npx tsx src/cli.ts snapshot save "$DEMO_DIR/day1.csv" --name demo
sleep 1   # see "Why the sleeps?" below

cp "$DEMO_DIR/day1.csv" "$DEMO_DIR/day2.csv"
npx tsx src/cli.ts snapshot save "$DEMO_DIR/day2.csv" --name demo
sleep 1
```

## Day 3: one SKU gets silently zeroed

Copy day 2, then flip SKU `ABC-123` (a Black Tee, 10 in stock) to quantity `0`,
simulating the sync wipe:

```bash
cp "$DEMO_DIR/day2.csv" "$DEMO_DIR/day3.csv"
sed -i '' 's/^tee-black,Black Tee,ABC-123,1000001,10,/tee-black,Black Tee,ABC-123,1000001,0,/' "$DEMO_DIR/day3.csv"
npx tsx src/cli.ts snapshot save "$DEMO_DIR/day3.csv" --name demo
```

(On Linux use `sed -i` without the `''` argument.)

## The check that catches it

```bash
npx tsx src/cli.ts snapshot check demo
```

Expected output (snapshot ids differ per run):

```
snapshot history for "demo": 3 snapshots
  2026-10-09T08-09-05  13 records
  2026-10-09T08-09-07  13 records
  2026-10-09T08-09-08  13 records

[CRITICAL] "ABC-123" was stocked across 2 snapshots (last: 10) but reads 0 in the latest (2026-10-09T08:09:08) — the classic "silently zeroed overnight" pattern
           fix: Verify against the warehouse/system of record before trusting the zero; check recent bulk imports and sync-app runs from the past day.
```

The command exits with status 1 on critical findings — wire it into cron/CI and
a silent wipe pages you the morning it happens.

## Why the sleeps?

Each snapshot's position in history is derived from its save timestamp, and
saves landing in the **same second** share one history position. Without
`sleep 1`, all three demo snapshots collapse into a single point and
`snapshot check` reports "No time-series findings". A real nightly cron is
naturally a day apart, so this only matters when scripting a demo in one go.

## Cleanup

```bash
unset INVENTORY_DOCTOR_SNAPSHOT_DIR
rm -rf "$DEMO_DIR"
```
