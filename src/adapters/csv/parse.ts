import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// Parse positional cells first: header mode can silently rename duplicate headers
// or overwrite their values. Keep data-row numbers stable (excluding blank rows).
export function parseCsvContent(content: string, source = 'CSV'): ParsedCsv {
  const result = Papa.parse<string[]>(content, {
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
  });
  const structuralError = result.errors.find((error) => error.code !== 'UndetectableDelimiter');
  if (structuralError) {
    const row = structuralError.row;
    const cells = row === undefined ? undefined : result.data[row];
    const column = cells?.length;
    const value = cells?.[cells.length - 1];
    throw new Error(`Invalid CSV in ${source}${row === undefined ? '' : ` at ${row === 0 ? 'header' : `data row ${row}`}`}${column === undefined ? '' : `, column ${column}, value ${JSON.stringify(value)}`}: ${structuralError.code}: ${structuralError.message}`);
  }
  const [rawHeaders = [], ...data] = result.data;
  const headers = rawHeaders.map((h) => h.trim());
  const seen = new Set<string>();
  for (const [index, header] of headers.entries()) {
    if (!header) throw new Error(`Invalid CSV in ${source}: empty header at column ${index + 1}`);
    const key = header.toLowerCase();
    if (seen.has(key)) throw new Error(`Invalid CSV in ${source}: duplicate header ${JSON.stringify(header)} at column ${index + 1}`);
    seen.add(key);
  }
  const rows = data.map((cells, index) => {
    if (cells.length !== headers.length) {
      const column = cells.length > headers.length ? headers.length + 1 : cells.length + 1;
      throw new Error(`Invalid CSV in ${source} at data row ${index + 1}, column ${column}: expected ${headers.length} columns, got ${cells.length}; values ${JSON.stringify(cells)}`);
    }
    if (cells.every((cell, i) => cell.trim().toLowerCase() === headers[i]!.toLowerCase())) {
      throw new Error(`Invalid CSV in ${source} at data row ${index + 1}: repeated header row ${JSON.stringify(cells)}`);
    }
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]!]));
  });
  return { headers, rows };
}

// Only decimal safe integers, optionally signed and properly comma-grouped.
// Blank remains null, never zero; malformed nonblank input is an error.
const INTEGER_RE = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/;

export function parseQuantity(raw: string | undefined): { quantity: number | null; quantityRaw: string; isBlank: boolean } {
  const quantityRaw = raw ?? '';
  const text = quantityRaw.trim();
  const isBlank = text === '';
  if (isBlank) return { quantity: null, quantityRaw, isBlank };
  const quantity = Number(text.replace(/,/g, ''));
  if (!INTEGER_RE.test(text) || !Number.isSafeInteger(quantity)) {
    throw new Error(`Invalid quantity ${JSON.stringify(quantityRaw)}: expected a decimal safe integer (optionally grouped thousands)`);
  }
  return { quantity, quantityRaw, isBlank };
}

export function parseQuantityCell(parsed: ParsedCsv, row: Record<string, string>, header: string | undefined, source: string, rowIndex: number) {
  if (!header) throw new Error(`Invalid CSV in ${source}: no quantity column could be identified`);
  try {
    return parseQuantity(row[header]);
  } catch (error) {
    throw new Error(`Invalid CSV in ${source} at data row ${rowIndex + 1}, column ${parsed.headers.indexOf(header) + 1} (${JSON.stringify(header)}), value ${JSON.stringify(row[header])}: ${(error as Error).message}`);
  }
}

export function blankToNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return raw.trim() === '' ? null : raw;
}
