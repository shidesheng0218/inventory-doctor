import type { DiagnoseReport, Finding, Severity } from '../core/types.js';

// Deterministic markdown (no timestamp) so fixtures/expected-report.md can be
// a living document checked against real output.
export function renderMarkdown(report: DiagnoseReport): string {
  const lines: string[] = [];
  lines.push('# Inventory Doctor Report');
  lines.push('');
  lines.push(`**Sources:** ${report.sources.map((s) => `\`${s}\``).join(' vs ')}`);
  lines.push('');
  lines.push('| Source | Records |');
  lines.push('| --- | ---: |');
  for (const [source, count] of Object.entries(report.recordCounts)) {
    lines.push(`| \`${source}\` | ${count} |`);
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
      lines.push(`- **[${f.rule}]** ${f.message}`);
      lines.push(`  - Suggestion: ${f.suggestion}`);
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
