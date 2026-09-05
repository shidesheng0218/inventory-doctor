import type { DiagnoseReport } from '../core/types.js';

export function renderJson(report: DiagnoseReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
