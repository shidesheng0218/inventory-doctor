import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/report/html.js';
import type { DiagnoseReport } from '../src/core/types.js';

const base: DiagnoseReport = {
  generatedAt: '2026-10-09T00:00:00.000Z',
  sources: ['store-a', 'store-b'],
  recordCounts: { 'store-a': 2, 'store-b': 2 },
  healthScore: 33,
  healthSummary: { matched: 0, minorDrift: 0, severeDrift: 1, unmatched: 1, totalCompared: 2 },
  findings: [
    { rule: 'oversell-risk', severity: 'critical',
      sku: '<img src=x onerror=alert(1)>',
      message: 'Sketchy "SKU" is out of stock in store-a but shows 8 in store-b',
      detail: {}, suggestion: 'Fix it' },
    { rule: 'quantity-drift', severity: 'info', sku: 'OK-1',
      message: 'Sync health score: 33/100', detail: {}, suggestion: '' },
  ],
};

describe('renderHtml', () => {
  it('escapes all untrusted interpolations (sku, message, source)', () => {
    const html = renderHtml(base);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
  it('renders health score and severity groups with counts', () => {
    const html = renderHtml(base);
    expect(html).toContain('Sync health score: 33/100');
    expect(html).toContain('Critical (1)');
  });
  it('is a self-contained document with no external resources', () => {
    const html = renderHtml(base);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
});
