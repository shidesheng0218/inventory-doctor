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
  // Whether the source genuinely had a BLANK cell for this quantity. CSV
  // parsers set true/false; API adapters set null because "blank cell" does
  // not exist for a live API read — a null quantity there means "not tracked",
  // not "someone left the cell empty". blank-vs-zero only fires on true.
  cellIsBlank: boolean | null;
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
  evidence?: string[]; // observations from the supplied records
  risk?: string; // conditional consequence, not a confirmed incident
  assumptions?: string[]; // premises needed to interpret the risk
  verification?: string[]; // checks before taking corrective action
}

// Bundle (kit) definition: how many of each component SKU it takes to
// assemble one sellable bundle. Used by the bundle-availability rule.
export interface BundleComponent {
  sku: string;
  quantity: number; // components needed per bundle, integer >= 1
}

export interface BundleDef {
  sku: string; // the bundle's own SKU as listed for sale
  components: BundleComponent[];
}

export interface DiagnoseOptions {
  // quantity-drift / oversell thresholds: flag when |a-b| > abs OR |a-b| / max(|a|,|b|) > pct — either tripwire fires.
  driftAbsThreshold: number;
  driftPctThreshold: number; // 0..1
  // Bundle kit definitions (usually from inventory-doctor.json top-level "bundles").
  bundles?: BundleDef[]; // empty/undefined → bundle-availability stays silent
  inventoryRelationship?: 'unknown' | 'shared' | 'independent';
  allowBackorders?: boolean; // intentional backorders reduce urgency, not the observed facts
  // Rule-level configuration (usually from inventory-doctor.json "rules").
  disabledRules?: string[]; // rule ids to skip entirely
  ignoreSkus?: string[]; // glob patterns ("GIFT-*") matched against the CANONICAL sku
  severityOverrides?: Record<string, Severity>; // rule id → forced severity
}

export const DEFAULT_DIAGNOSE_OPTIONS: DiagnoseOptions = {
  driftAbsThreshold: 5,
  driftPctThreshold: 0.2,
  inventoryRelationship: 'unknown',
  allowBackorders: false,
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
