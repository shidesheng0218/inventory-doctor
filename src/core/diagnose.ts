import type { DiagnoseOptions, DiagnoseReport, Finding, InventoryRecord, Severity } from './types.js';
import { DEFAULT_DIAGNOSE_OPTIONS } from './types.js';
import { distinctSources } from './match.js';
import { normalizeSku } from './normalize.js';
import { skuMismatch } from './rules/sku-mismatch.js';
import { oversellRisk } from './rules/oversell-risk.js';
import { blankVsZero } from './rules/blank-vs-zero.js';
import { barcodeCrosscheck } from './rules/barcode-crosscheck.js';
import { computeHealthSummary, healthScore, quantityDrift } from './rules/quantity-drift.js';
import { untracked } from './rules/untracked.js';
import { nightlyZero } from './rules/nightly-zero.js';

export const RULES = [
  'sku-mismatch',
  'oversell-risk',
  'blank-vs-zero',
  'barcode-crosscheck',
  'quantity-drift',
  'untracked',
  'nightly-zero',
] as const;

export type RuleId = (typeof RULES)[number];

type RuleFn = (records: InventoryRecord[], options: DiagnoseOptions) => Finding[];

const RULE_FNS: Record<RuleId, RuleFn> = {
  'sku-mismatch': (r) => skuMismatch(r),
  'oversell-risk': (r, o) => oversellRisk(r, o),
  'blank-vs-zero': (r) => blankVsZero(r),
  'barcode-crosscheck': (r) => barcodeCrosscheck(r),
  'quantity-drift': (r, o) => quantityDrift(r, o),
  untracked: (r) => untracked(r),
  'nightly-zero': (r) => nightlyZero(r),
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// Shell-style glob ("GIFT-*", "TEST-?") → anchored RegExp. Matched against
// the canonical (normalized) SKU so case/whitespace variants cannot sneak past.
export function globToRegExp(glob: string): RegExp {
  const escaped = normalizeSku(glob)
    .canonical.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function diagnose(
  records: InventoryRecord[],
  options: DiagnoseOptions = DEFAULT_DIAGNOSE_OPTIONS,
): DiagnoseReport {
  const disabled = new Set(options.disabledRules ?? []);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (disabled.has(rule)) continue;
    findings.push(...RULE_FNS[rule](records, options));
  }

  const ignore = (options.ignoreSkus ?? []).map(globToRegExp);
  const overrides = options.severityOverrides ?? {};
  const kept: Finding[] = [];
  for (const f of findings) {
    if (f.sku !== null && ignore.some((re) => re.test(normalizeSku(f.sku as string).canonical))) continue;
    const forced = overrides[f.rule];
    kept.push(forced !== undefined && forced !== f.severity ? { ...f, severity: forced } : f);
  }

  kept.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);

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
    findings: kept,
  };
}
