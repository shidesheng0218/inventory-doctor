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
    expect(parseQuantity('')).toEqual({ quantity: null, quantityRaw: '' });
    expect(parseQuantity('  ')).toEqual({ quantity: null, quantityRaw: '  ' });
    expect(parseQuantity('0')).toEqual({ quantity: 0, quantityRaw: '0' });
    expect(parseQuantity(' 0 ')).toEqual({ quantity: 0, quantityRaw: ' 0 ' });
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
});
