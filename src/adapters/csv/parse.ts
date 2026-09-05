import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// Parse CSV/TSV keeping EVERY cell a string: dynamic typing stays off so
// "0" remains "0" and "" remains "" — the blank-vs-zero distinction the whole
// tool is built on. Delimiter is auto-detected (comma or tab).
export function parseCsvContent(content: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    transform: (v) => v,
  });
  const headers = (result.meta.fields ?? []).filter((h) => h !== '');
  return { headers, rows: result.data };
}

// Cell value → quantity. Blank (empty or whitespace-only) becomes null and
// stays distinguishable from an explicit "0" via quantityRaw.
export function parseQuantity(raw: string | undefined): { quantity: number | null; quantityRaw: string } {
  const quantityRaw = raw ?? '';
  const trimmed = quantityRaw.trim();
  if (trimmed === '') return { quantity: null, quantityRaw };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { quantity: null, quantityRaw };
  return { quantity: Math.trunc(n), quantityRaw };
}

export function blankToNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : raw;
}
