import Papa from 'papaparse';
import type { DiagnoseReport, InventoryRecord } from '../core/types.js';
import { groupByCanonicalSku } from '../core/match.js';
import { normalizeSku } from '../core/normalize.js';

// Source order is a human-selected reconciliation assumption, not proof that
// the first source is correct. This export never represents an import file.
const BASIS = 'First report source is the human-selected reconciliation baseline, not objective truth; verify quantity semantics and counts before acting.';

export interface FixEvidence {
  sku: string | null;
  location: string | null;
  quantity: number | null;
  quantityRaw: string;
  basis: string;
}

export interface FixProposal {
  sku: string;
  location: string | null;
  targetSku: string | null;
  truthQuantity: number | null;
  targetQuantity: number | null;
  proposedAvailable: number | null;
  reason: string;
  basis: string;
  status: 'review-required' | 'blocked';
  blockedReasons: string[];
  truthEvidence: FixEvidence[];
  targetEvidence: FixEvidence[];
}

export interface FixRow extends FixProposal {
  // Compatibility alias for existing CLI previews; a proposal, never on-hand.
  quantity: number;
}

export interface FixExport {
  targetSource: string;
  rows: FixRow[];
  csv: string;
  reviewRequired: true;
  importable: false;
  truthSource: string;
  basis: string;
  // Includes blocked comparisons; rows contains only reviewable suggestions.
  proposals: FixProposal[];
}

function locationOf(record: InventoryRecord): string | null {
  return record.location?.trim() || null;
}

function quantityBasisOf(record: InventoryRecord): string {
  const basis = record.quantityBasis;
  return basis === 'available' || basis === 'on_hand' || basis === 'inventory' || basis === 'unknown' ? basis : 'unknown';
}

function evidence(records: InventoryRecord[]): FixEvidence[] {
  return records.map((r) => ({
    sku: r.sku,
    location: r.location,
    quantity: r.quantity,
    quantityRaw: r.quantityRaw,
    basis: quantityBasisOf(r),
  }));
}

export function buildFixExport(report: DiagnoseReport, records: InventoryRecord[]): FixExport {
  const truthSource = report.sources[0] ?? '';
  const targetSource = report.sources[1] ?? '';
  const result: FixExport = {
    targetSource, truthSource, rows: [], csv: '', reviewRequired: true, importable: false,
    basis: BASIS, proposals: [],
  };
  if (!truthSource || !targetSource || truthSource === targetSource) return result;
  const truthBuckets = groupByCanonicalSku(records, truthSource);
  const targetBuckets = groupByCanonicalSku(records, targetSource);
  const seen = new Set<string>();

  const consider = (sku: string, location: string | null, reason: string): void => {
    const canonical = normalizeSku(sku).canonical;
    const key = JSON.stringify([canonical, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const allTruth = truthBuckets.get(canonical)?.records ?? [];
    const allTarget = targetBuckets.get(canonical)?.records ?? [];
    // An absent location in a finding means a SKU aggregate. Never choose one
    // warehouse or distribute that aggregate to individual target records.
    const select = (items: InventoryRecord[]): InventoryRecord[] => location === null
      ? items : items.filter((r) => locationOf(r) === location);
    const truth = select(allTruth);
    const target = select(allTarget);
    const blockedReasons: string[] = [];
    if (!canonical) blockedReasons.push('missing-sku');
    if (truth.length === 0) blockedReasons.push('missing-baseline-match');
    if (target.length === 0) blockedReasons.push('missing-target-match');
    if (truth.length > 1) blockedReasons.push('non-unique-baseline-match');
    if (target.length > 1) blockedReasons.push('non-unique-target-match');
    const locations = new Set([...truth, ...target].map(locationOf));
    if (location === null && (locations.size > 1 || [...locations].some((l) => l !== null))) {
      blockedReasons.push('location-aggregate-or-mismatch');
    }
    const truthQuantity = truth.length === 1 ? truth[0]!.quantity : null;
    const targetQuantity = target.length === 1 ? target[0]!.quantity : null;
    if (truth.some((r) => r.quantity === null || !Number.isFinite(r.quantity))) blockedReasons.push('unknown-baseline-quantity');
    if (target.some((r) => r.quantity === null || !Number.isFinite(r.quantity))) blockedReasons.push('unknown-target-quantity');
    if (truthQuantity !== null && truthQuantity < 0) blockedReasons.push('negative-proposal');
    const truthEvidence = evidence(truth);
    const targetEvidence = evidence(target);
    const bases = new Set([...truthEvidence, ...targetEvidence].map((e) => e.basis));
    if ([...bases].some((b) => b !== 'available')) blockedReasons.push('unsupported-quantity-basis');
    if (bases.size > 1) blockedReasons.push('quantity-basis-mismatch');
    const proposal: FixProposal = {
      sku, location, targetSku: target.length === 1 ? target[0]!.sku : null,
      truthQuantity, targetQuantity,
      proposedAvailable: blockedReasons.length === 0 ? truthQuantity : null,
      reason, basis: `${BASIS} Quantity basis: ${[...bases].join(' / ') || 'unknown'}.`,
      status: blockedReasons.length === 0 ? 'review-required' : 'blocked',
      blockedReasons, truthEvidence, targetEvidence,
    };
    result.proposals.push(proposal);
    if (proposal.status === 'review-required' && proposal.proposedAvailable !== null) {
      result.rows.push({ ...proposal, quantity: proposal.proposedAvailable });
    }
  };

  for (const f of report.findings) {
    if (f.sku === null) continue;
    const d = f.detail;
    const pair = (d['sourceA'] === truthSource && d['sourceB'] === targetSource)
      || (d['sourceB'] === truthSource && d['sourceA'] === targetSource);
    const source = d['source'] === truthSource || d['source'] === targetSource;
    const quantityComparison = f.rule === 'oversell-risk' && pair;
    const blank = f.rule === 'blank-vs-zero' && source;
    const identity = f.rule === 'sku-mismatch' && ((pair && d['kind'] === 'orphan')
      || (source && Array.isArray(d['occurrences'])));
    if (!quantityComparison && !blank && !identity) continue;
    const location = typeof d['location'] === 'string' ? d['location'].trim() || null : null;
    consider(f.sku, location, f.rule);
  }
  // Missing identifiers cannot participate in canonical matching at all.
  for (const r of records) {
    if (r.source !== truthSource && r.source !== targetSource) continue;
    if (r.sku !== null && normalizeSku(r.sku).canonical !== '') continue;
    consider(r.sku ?? '', locationOf(r), 'missing-sku');
  }
  // Diagnostic severity/order may change without changing the evidence.
  const compare = (a: FixProposal, b: FixProposal): number =>
    JSON.stringify([normalizeSku(a.sku).canonical, a.location]).localeCompare(
      JSON.stringify([normalizeSku(b.sku).canonical, b.location]),
    );
  result.proposals.sort(compare);
  result.rows.sort(compare);
  if (result.proposals.length > 0) result.csv = toReviewCsv(result);
  return result;
}

function toReviewCsv(result: FixExport): string {
  const data = result.proposals.map((r) => ({
    'Review status': r.status,
    'Review required': 'true',
    Importable: 'false',
    'Document type': 'Review proposal only - NOT an importable repair file',
    'Baseline source (human-selected)': result.truthSource,
    'Target source': result.targetSource,
    'Compared SKU': r.sku,
    'Original target SKU': r.targetSku ?? '',
    'Compared location': r.location ?? '',
    'Baseline observed quantity': r.truthQuantity ?? '',
    'Target observed quantity': r.targetQuantity ?? '',
    'Proposed available quantity (review only)': r.proposedAvailable ?? '',
    Reason: r.reason,
    Basis: r.basis,
    'Blocked reasons': r.blockedReasons.join('; '),
    'Baseline evidence (JSON)': JSON.stringify(r.truthEvidence),
    'Target evidence (JSON)': JSON.stringify(r.targetEvidence),
  }));
  return Papa.unparse(data, { newline: '\n', escapeFormulae: true }) + '\n';
}
