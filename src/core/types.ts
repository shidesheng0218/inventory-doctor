// Core intermediate representation. Every adapter (CSV, Shopify API, ...)
// produces InventoryRecord[]; every diagnostic rule consumes it.

export interface InventoryRecord {
  source: string; // data source id, e.g. "store-a" / "amazon-export"
  sku: string | null; // raw SKU, NOT normalized
  barcode: string | null; // for cross-checking
  title: string | null;
  location: string | null; // null = source has no location dimension
  quantity: number | null; // null !== 0; this distinction is a core capability
  quantityRaw: string; // raw cell content, used to tell blank from "0"
  tracked: boolean | null; // whether Shopify's inventory tracker is on
  meta: Record<string, string>; // other columns, kept for extensibility
}

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  sku: string | null;
  message: string;
  detail: Record<string, unknown>;
  suggestion: string; // what the merchant should do
}

export interface DiagnoseOptions {
  // quantity-drift / oversell thresholds: flag when |a-b| > max(abs, pct * max(|a|,|b|))
  driftAbsThreshold: number;
  driftPctThreshold: number; // 0..1
}

export const DEFAULT_DIAGNOSE_OPTIONS: DiagnoseOptions = {
  driftAbsThreshold: 5,
  driftPctThreshold: 0.2,
};

export interface DiagnoseReport {
  generatedAt: string; // ISO timestamp
  sources: string[];
  recordCounts: Record<string, number>;
  healthScore: number; // 0-100, from R5
  healthSummary: HealthSummary;
  findings: Finding[];
}

export interface HealthSummary {
  matched: number; // SKUs whose quantities agree across sources
  minorDrift: number; // within thresholds but not identical
  severeDrift: number; // beyond thresholds
  unmatched: number; // present in only one source
  totalCompared: number;
}
