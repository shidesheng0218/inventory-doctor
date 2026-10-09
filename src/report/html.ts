import type { DiagnoseReport, Finding, Severity } from '../core/types.js';

// Self-contained single-file HTML report: inline CSS, no external resources,
// every untrusted interpolation escaped.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#c0392b',
  warning: '#b58900',
  info: '#555',
};

export function renderHtml(report: DiagnoseReport): string {
  const h = report.healthSummary;
  const score = report.healthScore;

  const parts: string[] = [];
  parts.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inventory Doctor Report</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  margin: 2rem; color: #222; line-height: 1.5; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
table { border-collapse: collapse; margin: 0.75rem 0; }
th, td { border: 1px solid #ddd; padding: 0.4rem 0.75rem; text-align: left; font-size: 0.9rem; }
th { background: #f6f6f6; }
.score { font-size: 2rem; font-weight: 700; }
.bar { background: #eee; border-radius: 4px; height: 12px; width: 240px; overflow: hidden; margin: 0.5rem 0; }
.bar-fill { height: 100%; }
.sev { font-weight: 700; }
.meta { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Inventory Doctor Report</h1>
<p class="meta">Generated ${escapeHtml(report.generatedAt)} — comparing ${report.sources.map((s) => `<code>${escapeHtml(s)}</code>`).join(' vs ')}</p>

<h2>Sources</h2>
<table>
<thead><tr><th>Source</th><th>Records</th></tr></thead>
<tbody>
`);
  for (const [source, count] of Object.entries(report.recordCounts)) {
    parts.push(`<tr><td><code>${escapeHtml(source)}</code></td><td>${count}</td></tr>\n`);
  }
  parts.push(`</tbody>
</table>

<h2>Sync health score: ${score}/100</h2>
<div class="score">${score}/100</div>
<div class="bar"><div class="bar-fill" style="width: ${score}%; background: #2e8b57;"></div></div>

<h2>Health summary</h2>
<table>
<thead><tr><th>Exact match</th><th>Minor drift</th><th>Severe drift</th><th>Unmatched</th><th>Total compared</th></tr></thead>
<tbody>
<tr><td>${h.matched}</td><td>${h.minorDrift}</td><td>${h.severeDrift}</td><td>${h.unmatched}</td><td>${h.totalCompared}</td></tr>
</tbody>
</table>
`);

  const bySeverity = groupBySeverity(report.findings);
  for (const severity of ['critical', 'warning', 'info'] as Severity[]) {
    const findings = bySeverity.get(severity) ?? [];
    if (findings.length === 0) continue;
    const color = SEVERITY_COLORS[severity];
    parts.push(`<h2><span class="sev" style="color: ${color};">${capitalize(severity)} (${findings.length})</span></h2>\n`);
    parts.push(`<table>
<thead><tr><th>Rule</th><th>SKU</th><th>Message</th><th>Suggestion</th></tr></thead>
<tbody>
`);
    for (const f of findings) {
      const sku = f.sku === null ? '—' : escapeHtml(f.sku);
      const suggestion = f.suggestion === '' ? '—' : escapeHtml(f.suggestion);
      parts.push(
        `<tr><td><code>${escapeHtml(f.rule)}</code></td><td><code>${sku}</code></td>` +
          `<td>${escapeHtml(f.message)}</td><td>${suggestion}</td></tr>\n`,
      );
    }
    parts.push(`</tbody>
</table>
`);
  }

  if (report.findings.length === 0) {
    parts.push(`<p>No findings. Sources look consistent.</p>\n`);
  }

  parts.push(`</body>
</html>
`);
  return parts.join('');
}
