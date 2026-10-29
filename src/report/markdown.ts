import type { DiagnoseReport, Finding, Severity } from '../core/types.js';

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .split(String.fromCharCode(8232)).join(' ').split(String.fromCharCode(8233)).join(' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, '\\$1');
}

function code(value: string): string {
  const safe = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .split(String.fromCharCode(8232)).join(' ').split(String.fromCharCode(8233)).join(' ')
    // GFM splits table cells before parsing code spans, so pipes still need escaping.
    .replace(/\|/g, '\\|');
  // Backslashes do not escape backticks in code spans. A longer delimiter keeps
  // embedded backticks and HTML-looking text inside the literal code content.
  const delimiter = '`'.repeat(Math.max(0, ...[...safe.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  const padding = safe.startsWith('`') || safe.endsWith('`') || /^ .* $/.test(safe) ? ' ' : '';
  return `${delimiter}${padding}${safe}${padding}${delimiter}`;
}

// Deterministic markdown (no timestamp).
export function renderMarkdown(report: DiagnoseReport): string {
  const lines: string[] = [];
  lines.push('# Inventory Doctor Report');
  lines.push('');
  lines.push(`**Sources:** ${report.sources.map(code).join(' vs ')}`);
  lines.push('');
  lines.push('| Source | Records |');
  lines.push('| --- | ---: |');
  for (const [source, count] of Object.entries(report.recordCounts)) {
    lines.push(`| ${code(source)} | ${count} |`);
  }
  lines.push('');
  lines.push(`## Sync health score: ${report.healthScore}/100`);
  lines.push('');
  const h = report.healthSummary;
  lines.push('| Exact match | Minor drift | Severe drift | Unmatched | Total compared |');
  lines.push('| ---: | ---: | ---: | ---: | ---: |');
  lines.push(`| ${h.matched} | ${h.minorDrift} | ${h.severeDrift} | ${h.unmatched} | ${h.totalCompared} |`);
  lines.push('');

  const bySeverity = groupBySeverity(report.findings);
  for (const severity of ['critical', 'warning', 'info'] as Severity[]) {
    const findings = bySeverity.get(severity) ?? [];
    if (findings.length === 0) continue;
    lines.push(`## ${capitalize(severity)} (${findings.length})`);
    lines.push('');
    for (const f of findings) {
      lines.push(`- **[${escapeMarkdown(f.rule)}]** ${escapeMarkdown(f.message)}`);
      if (f.evidence?.length) lines.push(`  - Observed: ${f.evidence.map(escapeMarkdown).join('; ')}`);
      if (f.risk) lines.push(`  - Conditional risk: ${escapeMarkdown(f.risk)}`);
      if (f.assumptions?.length) lines.push(`  - Assumptions: ${f.assumptions.map(escapeMarkdown).join('; ')}`);
      if (f.verification?.length) lines.push(`  - Verify: ${f.verification.map(escapeMarkdown).join('; ')}`);
      lines.push(`  - Suggestion: ${escapeMarkdown(f.suggestion)}`);
    }
    lines.push('');
  }

  if (report.findings.length === 0) {
    lines.push('No findings. Sources look consistent.');
    lines.push('');
  }
  return lines.join('\n');
}

function groupBySeverity(findings: Finding[]): Map<Severity, Finding[]> {
  const map = new Map<Severity, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.severity) ?? [];
    list.push(f);
    map.set(f.severity, list);
  }
  return map;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
