// Column-name alias dictionary. Shopify product CSV exports renamed headers
// but imports still accept the old names, so BOTH sets appear in the wild and
// must map to the same canonical field. Matching is case-insensitive and
// tolerant of "(not editable)" / "(current)" / "(new)" suffixes.

export type CanonicalField =
  | 'handle'
  | 'title'
  | 'sku'
  | 'barcode'
  | 'quantity'
  | 'tracked'
  | 'inventoryPolicy'
  | 'location'
  | 'binName'
  | 'optionName'
  | 'optionValue'
  | 'incoming'
  | 'unavailable'
  | 'committed'
  | 'available'
  | 'onHandCurrent'
  | 'onHandNew';

const ALIASES: Record<CanonicalField, string[]> = {
  // old import header first, current export header second
  handle: ['Handle', 'URL handle'],
  title: ['Title'],
  sku: ['Variant SKU', 'SKU', 'seller-sku', 'sku', 'Seller SKU'],
  barcode: ['Variant Barcode', 'Barcode', 'barcode', 'gtin', 'upc', 'ean', 'asin1'],
  quantity: ['Variant Inventory Qty', 'Inventory quantity', 'quantity', 'qty', 'stock', 'Quantity'],
  tracked: ['Inventory tracker', 'Variant Inventory Tracker', 'tracked'],
  inventoryPolicy: ['Variant Inventory Policy', 'Inventory policy', 'Continue selling when out of stock'],
  location: ['Location', 'location', 'fulfillment-channel'],
  binName: ['Bin name'],
  optionName: ['Option1 Name', 'Option 1 Name'],
  optionValue: ['Option1 Value', 'Option 1 Value'],
  incoming: ['Incoming (not editable)', 'Incoming'],
  unavailable: ['Unavailable (not editable)', 'Unavailable'],
  committed: ['Committed (not editable)', 'Committed'],
  available: ['Available (not editable)', 'Available'],
  onHandCurrent: ['On hand (current)'],
  onHandNew: ['On hand (new)'],
};

const SUFFIXES = ['(not editable)', '(current)', '(new)'];

// Normalize a header for comparison: lowercase, collapse whitespace,
// strip known parenthesized suffixes.
function normalizeHeader(header: string): string {
  let h = header.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const suffix of SUFFIXES) {
    const s = ` ${suffix.toLowerCase()}`;
    if (h.endsWith(s)) {
      h = h.slice(0, -s.length).trim();
    }
  }
  return h;
}

interface IndexEntry {
  normalized: string;
  field: CanonicalField;
}

let cachedIndex: IndexEntry[] | null = null;

function aliasIndex(): IndexEntry[] {
  if (cachedIndex) return cachedIndex;
  const entries: IndexEntry[] = [];
  for (const [field, names] of Object.entries(ALIASES) as Array<[CanonicalField, string[]]>) {
    for (const name of names) {
      entries.push({ normalized: normalizeHeader(name), field });
    }
  }
  cachedIndex = entries;
  return entries;
}

// Map a raw CSV header to its canonical field, or null if unknown.
export function resolveHeader(header: string): CanonicalField | null {
  const normalized = normalizeHeader(header);
  const hit = aliasIndex().find((e) => e.normalized === normalized);
  return hit ? hit.field : null;
}

// Resolve all headers of a file at once.
export function mapHeaders(headers: string[]): Map<string, CanonicalField> {
  const map = new Map<string, CanonicalField>();
  for (const h of headers) {
    const field = resolveHeader(h);
    if (field) map.set(h, field);
  }
  return map;
}

export function knownFieldsOf(headers: string[]): Set<CanonicalField> {
  return new Set(mapHeaders(headers).values());
}
