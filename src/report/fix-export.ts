import Papa from 'papaparse';
import type { DiagnoseReport, InventoryRecord } from '../core/types.js';
import { groupByCanonicalSku, hasLocationDimension, perLocationQuantities, aggregateQuantity } from '../core/match.js';
import { normalizeSku } from '../core/normalize.js';

// Fix export: turn critical findings into a Shopify-importable inventory CSV
// that brings the SECOND source in line with the FIRST (the source of truth).
// The tool never writes to any API — the merchant reviews this file and
// imports it themselves, which keeps the fix auditable.

export interface FixRow {
  sku: string;
  location: string | null;
  quantity: number;
  reason: string;
}

export interface FixExport {
  targetSource: string; // the source these rows should be imported into
  rows: FixRow[];
  csv: string;
}

export function buildFixExport(report: DiagnoseReport, records: InventoryRecord[]): FixExport {
  const truth = report.sources[0];
  const target = report.sources[1];
  if (truth === undefined || target === undefined) {
    return { targetSource: '', rows: [], csv: '' };
  }
  const truthBuckets = groupByCanonicalSku(records, truth);

  const rows: FixRow[] = [];
  const seen = new Set<string>();
  const push = (sku: string, location: string | null, quantity: number, reason: string): void => {
    const key = `${normalizeSku(sku).canonical}${location ?? ''}`;
    if (seen.has(key)) return; // first (highest-severity) finding wins
    seen.add(key);
    rows.push({ sku, location, quantity, reason });
  };

  for (const f of report.findings) {
    if (f.severity !== 'critical' || f.sku === null) continue;

    if (f.rule === 'oversell-risk') {
      const d = f.detail as { sourceA?: string; sourceB?: string; quantityA?: number; quantityB?: number; location?: string };
      const location = typeof d.location === 'string' ? d.location : null;
      // Copy the truth side's quantity over the other side's.
      if (d.sourceA === truth && typeof d.quantityA === 'number') {
        push(f.sku, location, d.quantityA, f.rule);
      } else if (d.sourceB === truth && typeof d.quantityB === 'number') {
        push(f.sku, location, d.quantityB, f.rule);
      }
      continue;
    }

    if (f.rule === 'blank-vs-zero') {
      const d = f.detail as { source?: string; location?: string | null };
      if (d.source !== target) continue; // the blank is on the truth side — nothing safe to write
      const bucket = truthBuckets.get(normalizeSku(f.sku).canonical);
      if (!bucket) continue;
      const location = typeof d.location === 'string' ? d.location : null;
      let quantity: number | null;
      if (location !== null && hasLocationDimension(bucket)) {
        quantity = perLocationQuantities(bucket).get(location)?.quantity ?? null;
      } else {
        quantity = aggregateQuantity(bucket);
      }
      if (quantity !== null) push(f.sku, location, quantity, f.rule);
    }
  }

  return { targetSource: target, rows, csv: rows.length === 0 ? '' : toInventoryCsv(rows) };
}

// Long-format Shopify inventory CSV (SKU + Location + state columns), the same
// shape Shopify exports and re-imports — and this tool's own adapter reads it
// back, so a fix file can be re-diffed to confirm it would heal the report.
function toInventoryCsv(rows: FixRow[]): string {
  const data = rows.map((r) => ({
    SKU: r.sku,
    Location: r.location ?? '',
    'Available (not editable)': String(r.quantity),
    'On hand (new)': String(r.quantity),
    Reason: r.reason,
  }));
  return Papa.unparse(data, { columns: ['SKU', 'Location', 'Available (not editable)', 'On hand (new)', 'Reason'] }) + '\n';
}
