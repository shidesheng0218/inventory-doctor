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

// Cell value → quantity + whether the cell was genuinely blank. Blank (empty
// or whitespace-only) becomes null and stays distinguishable from an explicit
// "0" via quantityRaw. `isBlank` is the CSV-only signal that the blank-vs-zero
// rule keys on — an API source never sets it (a null quantity there means
// "not tracked", not "empty cell").
//
// Thousands separators: "1,234" is a common ERP export shape and must read as
// 1234, not 1. Only the unambiguous grouped form (-?\d{1,3}(,\d{3})+) is
// stripped — "1,5" / "12,34" (possible decimal-comma) are left alone so they
// stay null and surface as unreadable rather than being silently misread.
const THOUSANDS_RE = /^-?\d{1,3}(,\d{3})+$/;

export function parseQuantity(raw: string | undefined): { quantity: number | null; quantityRaw: string; isBlank: boolean } {
  const quantityRaw = raw ?? '';
  const isBlank = quantityRaw.trim() === '';
  if (isBlank) return { quantity: null, quantityRaw, isBlank };

  let text = quantityRaw.trim();
  if (THOUSANDS_RE.test(text)) text = text.replace(/,/g, '');

  const n = Number(text);
  if (!Number.isFinite(n)) return { quantity: null, quantityRaw, isBlank };
  return { quantity: Math.trunc(n), quantityRaw, isBlank };
}

export function blankToNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : raw;
}
