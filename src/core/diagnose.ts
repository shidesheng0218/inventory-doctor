import type { DiagnoseOptions, DiagnoseReport, Finding, InventoryRecord } from './types.js';
import { DEFAULT_DIAGNOSE_OPTIONS } from './types.js';
import { distinctSources } from './match.js';
import { skuMismatch } from './rules/sku-mismatch.js';
import { oversellRisk } from './rules/oversell-risk.js';
import { blankVsZero } from './rules/blank-vs-zero.js';
import { barcodeCrosscheck } from './rules/barcode-crosscheck.js';
import { computeHealthSummary, healthScore, quantityDrift } from './rules/quantity-drift.js';
import { untracked } from './rules/untracked.js';

export const RULES = [
  'sku-mismatch',
  'oversell-risk',
  'blank-vs-zero',
  'barcode-crosscheck',
  'quantity-drift',
  'untracked',
] as const;

const SEVERITY_ORDER: Record<Finding['severity'], number> = { critical: 0, warning: 1, info: 2 };

export function diagnose(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): DiagnoseReport {
  const findings: Finding[] = [
    ...skuMismatch(records),
    ...oversellRisk(records, options),
    ...blankVsZero(records),
    ...barcodeCrosscheck(records),
    ...quantityDrift(records, options),
    ...untracked(records),
  ];

  findings.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);

  const sources = distinctSources(records);
  const recordCounts: Record<string, number> = {};
  for (const source of sources) {
    recordCounts[source] = records.filter((r) => r.source === source).length;
  }
  const healthSummary = computeHealthSummary(records, options);

  return {
    generatedAt: new Date().toISOString(),
    sources,
    recordCounts,
    healthScore: healthScore(healthSummary),
    healthSummary,
    findings,
  };
}
