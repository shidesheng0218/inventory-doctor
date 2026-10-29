import type { DiagnoseReport, Finding, Severity } from '../core/types.js';

function cleanTerminal(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/g, '').replace(/\r?\n/g, ' ');
}

const TAG: Record<Severity, string> = {
  critical: '[CRITICAL]',
  warning: '[WARN]    ',
  info: '[INFO]    ',
};

export function renderTerminal(report: DiagnoseReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('inventory-doctor — sync diagnosis');
  lines.push('='.repeat(60));
  lines.push(`Sources: ${report.sources.map(cleanTerminal).join('  vs  ')}`);
  for (const [source, count] of Object.entries(report.recordCounts)) {
    lines.push(`  ${cleanTerminal(source)}: ${count} records`);
  }
  lines.push('');
  lines.push(`Sync health score: ${report.healthScore}/100`);
  const h = report.healthSummary;
  lines.push(
    `  exact match: ${h.matched} · minor drift: ${h.minorDrift} · severe drift: ${h.severeDrift} · unmatched: ${h.unmatched} (of ${h.totalCompared})`,
  );
  lines.push('');

  const bySeverity = groupBySeverity(report.findings);
  for (const severity of ['critical', 'warning', 'info'] as Severity[]) {
    const findings = bySeverity.get(severity) ?? [];
    if (findings.length === 0) continue;
    lines.push(`${severity.toUpperCase()} (${findings.length})`);
    lines.push('-'.repeat(60));
    for (const f of findings) {
      lines.push(`${TAG[severity]} ${cleanTerminal(f.message)}`);
      if (f.evidence?.length) lines.push(`           observed: ${f.evidence.map(cleanTerminal).join(' | ')}`);
      if (f.risk) lines.push(`           risk: ${cleanTerminal(f.risk)}`);
      if (f.assumptions?.length) lines.push(`           assumptions: ${f.assumptions.map(cleanTerminal).join(' | ')}`);
      if (f.verification?.length) lines.push(`           verify: ${f.verification.map(cleanTerminal).join(' | ')}`);
      lines.push(`           rule: ${cleanTerminal(f.rule)}`);
      lines.push(`           fix:  ${cleanTerminal(f.suggestion)}`);
    }
    lines.push('');
  }

  if (report.findings.length === 0) {
    lines.push('No findings. Sources look consistent.');
  }
  return lines.join('\n') + '\n';
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
