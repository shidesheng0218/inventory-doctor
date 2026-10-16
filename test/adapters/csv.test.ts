import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCsv } from '../../src/adapters/csv/index.js';
import { parseQuantity } from '../../src/adapters/csv/parse.js';

const OLD_HEADERS_PRODUCT = `Handle,Title,Variant SKU,Variant Barcode,Variant Inventory Qty,Inventory tracker
tee,Black Tee,ABC-123,111,10,shopify
`;

const NEW_HEADERS_PRODUCT = `URL handle,Title,SKU,Barcode,Inventory quantity,Inventory tracker
tee,Black Tee,ABC-123,111,10,shopify
`;

const LONG_INVENTORY = `Handle,Title,Option 1 Name,Option 1 Value,SKU,Location,Bin name,Incoming (not editable),Unavailable (not editable),Committed (not editable),Available (not editable),On hand (current),On hand (new)
tee,Black Tee,Size,M,ABC-123,Warehouse A,,0,0,2,8,10,10
tee,Black Tee,Size,M,ABC-123,Warehouse B,,1,0,0,4,5,5
`;

const WIDE_INVENTORY = `Handle,Title,SKU,Barcode,Warehouse A,Warehouse B
tee,Black Tee,ABC-123,111,8,4
mug,White Mug,DEF-456,222,,3
`;

describe('CSV detection + parsing', () => {
  it('accepts the OLD Shopify product CSV headers', () => {
    const { records, detection } = loadCsv(OLD_HEADERS_PRODUCT, 'old');
    expect(detection.format).toBe('shopify-product');
    expect(records[0]).toMatchObject({ sku: 'ABC-123', barcode: '111', quantity: 10, tracked: true });
  });

  it('accepts the NEW Shopify product CSV headers (same records)', () => {
    const { records, detection } = loadCsv(NEW_HEADERS_PRODUCT, 'new');
    expect(detection.format).toBe('shopify-product');
    expect(records[0]).toMatchObject({ sku: 'ABC-123', barcode: '111', quantity: 10, tracked: true });
  });

  it('parses the long inventory format: one record per variant × location', () => {
    const { records, detection } = loadCsv(LONG_INVENTORY, 'inv');
    expect(detection.format).toBe('shopify-inventory-long');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ sku: 'ABC-123', location: 'Warehouse A', quantity: 8 });
    expect(records[1]).toMatchObject({ sku: 'ABC-123', location: 'Warehouse B', quantity: 4 });
    expect(records[0]?.meta['committed']).toBe('2');
    expect(records[1]?.meta['incoming']).toBe('1');
  });

  it('parses the wide inventory format: location names as column headers', () => {
    const { records, detection } = loadCsv(WIDE_INVENTORY, 'inv');
    expect(detection.format).toBe('shopify-inventory-wide');
    expect(detection.locationColumns).toEqual(['Warehouse A', 'Warehouse B']);
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ sku: 'ABC-123', location: 'Warehouse A', quantity: 8 });
    // Blank cell in a wide table stays null, NOT zero.
    const blank = records.find((r) => r.sku === 'DEF-456' && r.location === 'Warehouse A');
    expect(blank?.quantity).toBeNull();
    expect(blank?.quantityRaw).toBe('');
  });

  it('keeps blank cells and explicit "0" strictly distinct', () => {
    expect(parseQuantity('')).toEqual({ quantity: null, quantityRaw: '', isBlank: true });
    expect(parseQuantity('  ')).toEqual({ quantity: null, quantityRaw: '  ', isBlank: true });
    expect(parseQuantity('0')).toEqual({ quantity: 0, quantityRaw: '0', isBlank: false });
    expect(parseQuantity(' 0 ')).toEqual({ quantity: 0, quantityRaw: ' 0 ', isBlank: false });
  });

  it('reads grouped thousands separators and rejects ambiguous comma forms', () => {
    // "1,234" is a common ERP export shape — must be 1234, not 1.
    expect(parseQuantity('1,234').quantity).toBe(1234);
    expect(parseQuantity('12,345').quantity).toBe(12345);
    expect(parseQuantity('1,234,567').quantity).toBe(1234567);
    // Ambiguous decimal-comma shapes must fail instead of becoming stock counts.
    expect(() => parseQuantity('1,5')).toThrow(/Invalid quantity/);
    expect(() => parseQuantity('12,34')).toThrow(/Invalid quantity/);
    expect(() => parseQuantity('1,23')).toThrow(/Invalid quantity/);
  });

  it('falls back to generic probing for unknown layouts (e.g. Amazon-style)', () => {
    const amazon = 'seller-sku\tasin1\tquantity\tfulfillment-channel\nAMZ-1\tB00X\t7\tFBA\n';
    const { records, detection } = loadCsv(amazon, 'amz');
    expect(detection.format).toBe('generic');
    expect(records[0]).toMatchObject({ sku: 'AMZ-1', quantity: 7, location: 'FBA' });
  });

  it('honors an explicit column mapping when aliases fail', () => {
    const weird = 'Item Code,Stock Count\nW-1,3\n';
    const { records } = loadCsv(weird, 'weird', { sku: 'Item Code', quantity: 'Stock Count' });
    expect(records[0]).toMatchObject({ sku: 'W-1', quantity: 3 });
  });

  it('throws a helpful error when no SKU column can be found', () => {
    expect(() => loadCsv('Foo,Bar\n1,2\n', 'x')).toThrow(/SKU column/);
  });

  it('does NOT treat unrecognized text/price columns as inventory locations', () => {
    // An ERP-style export with descriptive columns must not be misread as a
    // wide multi-location inventory table — Price/Weight are not locations and
    // their values are not stock counts.
    const erp = 'SKU,Product Name,Price,Weight\nABC-1,Blue Widget,19.99,2.5\nDEF-2,Red Widget,5.00,1.0\n';
    expect(() => loadCsv(erp, 'erp')).toThrow(/erp.*no quantity column/);
  });

  it('still detects a genuine wide inventory table whose location columns hold numbers', () => {
    const wide = 'SKU,Warehouse A,Warehouse B\nABC-1,8,4\nDEF-2,1,3\n';
    const { detection, records } = loadCsv(wide, 'inv');
    expect(detection.format).toBe('shopify-inventory-wide');
    expect(detection.locationColumns).toEqual(['Warehouse A', 'Warehouse B']);
    expect(records).toHaveLength(4);
  });
});


describe('CSV integrity regressions', () => {
  it.each(['1e3', '0x10', '0b11', '1.2', '1.0', 'Infinity', 'NaN', 'abc', '9007199254740992', '1,23', '1234,567'])('rejects invalid quantity %s', (value) => {
    expect(() => parseQuantity(value)).toThrow(/decimal safe integer/);
    expect(() => loadCsv(`SKU,Quantity\nA,"${value}"\n`, 'bad-source')).toThrow(/bad-source.*data row 1.*column 2.*Quantity.*value/);
  });

  it.each(['-1,234', '+1,234', '9,007,199,254,740,991', '-9007199254740991', '0012'])('accepts decimal integer %s', (value) => {
    expect(parseQuantity(value).quantity).toBe(Number(value.replace(/,/g, '')));
  });

  it.each([
    'SKU,Quantity\nA,2,extra\n',
    'SKU,Quantity\nA\n',
    'SKU,Quantity\nA,"2\n',
    'SKU,Quantity\nA,"2"oops\n',
    'SKU,Quantity, Quantity \nA,2,3\n',
    'SKU,Quantity,quantity\nA,2,3\n',
    'SKU,Quantity\nA,2\nSKU,Quantity\n',
  ])('fails loud on structural CSV errors', (content) => {
    expect(() => loadCsv(content, 'broken')).toThrow(/broken/);
  });

  it('reports the correct data row, header, and raw value', () => {
    expect(() => loadCsv('SKU,Quantity\nA,2\nB,nope\n', 'erp')).toThrow(/erp.*data row 2.*column 2.*Quantity.*"nope"/);
  });

  it('requires quantity even for empty files and state-only long tables', () => {
    expect(() => loadCsv('SKU,Title\n', 'empty')).toThrow(/no quantity column/);
    expect(() => loadCsv('SKU,Location,Incoming\nA,Main,3\n', 'incoming')).toThrow(/no quantity column/);
  });

  it('rejects missing explicit mappings instead of falling back to aliases', () => {
    for (const field of ['sku', 'quantity', 'title', 'barcode', 'location']) {
      expect(() => loadCsv(OLD_HEADERS_PRODUCT, 'mapped', { [field]: 'Missing' })).toThrow(/mapped.*Missing.*does not exist/);
    }
  });

  it('mapping takes precedence over product, long and wide detection', () => {
    const product = OLD_HEADERS_PRODUCT.replace('Inventory tracker', 'Inventory tracker,Actual').replace('10,shopify', '10,shopify,22');
    expect(loadCsv(product, 'p', { quantity: 'Actual' }).records[0]?.quantity).toBe(22);
    expect(loadCsv(LONG_INVENTORY, 'l', { quantity: 'On hand (current)' }).records.map((r) => r.quantity)).toEqual([10, 5]);
    const wide = loadCsv(WIDE_INVENTORY, 'w', { quantity: 'Warehouse B' });
    expect(wide.detection.format).toBe('generic');
    expect(wide.records.map((r) => r.quantity)).toEqual([4, 3]);
  });

  it('does not infer arbitrary integer descriptive columns as locations', () => {
    expect(() => loadCsv('SKU,Years,Rank,Custom Metric\nA,2026,1,20\n', 'descriptive')).toThrow(/no quantity column/);
    const { detection, records } = loadCsv('SKU,Warehouse A,Rank,Custom Metric\nA,5,1,20\n', 'wide');
    expect(detection.locationColumns).toEqual(['Warehouse A']);
    expect(records).toHaveLength(1);
  });

  it('keeps repository wide fixtures valid, including blank quantities', () => {
    for (const name of ['shopify-inventory-wide-e.csv', 'shopify-inventory-wide-f.csv']) {
      const content = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
      const result = loadCsv(content, name);
      expect(result.detection.format).toBe('shopify-inventory-wide');
      expect(result.records).toHaveLength(4);
    }
  });

  it('validates quantities in all detected layouts', () => {
    expect(() => loadCsv(OLD_HEADERS_PRODUCT.replace(',10,', ',1.5,'), 'product')).toThrow(/product.*Variant Inventory Qty/);
    expect(() => loadCsv(LONG_INVENTORY.replace(',2,8,10,10', ',2,nope,10,10'), 'long')).toThrow(/long.*Available/);
    expect(() => loadCsv(WIDE_INVENTORY.replace(',8,4', ',bad,4'), 'wide')).toThrow(/wide.*Warehouse A/);
  });
});
