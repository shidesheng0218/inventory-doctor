import { describe, expect, it, vi } from 'vitest';
import { WooClient } from '../../src/adapters/woocommerce/client.js';
import { fetchWooInventory } from '../../src/adapters/woocommerce/fetch-inventory.js';

const noSleep = () => Promise.resolve();

function jsonResponse(body: unknown, totalPages = 1, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-WP-TotalPages': String(totalPages) },
  });
}

function makeClient(fetchFn: typeof fetch, sleeps: number[] = []): WooClient {
  return new WooClient({
    baseUrl: 'https://shop.example.com/',
    consumerKey: 'ck_x',
    consumerSecret: 'cs_y',
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return noSleep();
    },
  });
}

describe('WooClient', () => {
  it('refuses plain-HTTP base URLs (Basic Auth would leak)', () => {
    expect(() => new WooClient({ baseUrl: 'http://shop.example.com', consumerKey: 'a', consumerSecret: 'b' })).toThrow(
      /https/,
    );
  });

  it('sends Basic Auth and paginates via X-WP-TotalPages', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }], 2))
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }], 2));
    const client = makeClient(fetchFn);
    const all = await client.getAll<{ id: number }>('/products?status=publish');

    expect(all.map((p) => p.id)).toEqual([1, 2]);
    const [url1, init1] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url1).toBe('https://shop.example.com/wp-json/wc/v3/products?status=publish&per_page=100&page=1');
    expect((init1.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from('ck_x:cs_y').toString('base64')}`,
    );
    const [url2] = fetchFn.mock.calls[1] as [string];
    expect(url2).toContain('page=2');
  });

  it('backs off 1s and retries on HTTP 429', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]));
    const client = makeClient(fetchFn, sleeps);
    const all = await client.getAll('/products');
    expect(all).toHaveLength(1);
    expect(sleeps).toEqual([1000]);
  });

  it('retries transient network errors like 429s', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]));
    const client = makeClient(fetchFn, sleeps);
    const all = await client.getAll<{ id: number }>('/products');
    expect(all).toHaveLength(1);
    expect(sleeps).toEqual([1000]);
  });

  it('times out a hung request instead of waiting forever', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out', 'TimeoutError')),
          );
        }),
    );
    const client = new WooClient({
      baseUrl: 'https://shop.example.com',
      consumerKey: 'ck_x',
      consumerSecret: 'cs_y',
      fetchFn,
      sleep: noSleep,
      timeoutMs: 5,
      maxRetries: 1,
    });
    await expect(client.getAll('/products')).rejects.toThrow(/timed out after 5ms/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWooInventory', () => {
  it('maps products and variations to InventoryRecords', async () => {
    const products = [
      { id: 1, name: 'Mug', type: 'simple', sku: 'MUG-1', manage_stock: true, stock_quantity: 7, backorders: 'no' },
      { id: 2, name: 'Gift Card', type: 'simple', sku: 'GIFT-1', manage_stock: false, stock_quantity: null, backorders: 'no' },
      { id: 3, name: 'Tee', type: 'variable', sku: '', manage_stock: false, stock_quantity: null, backorders: 'no' },
      { id: 4, name: 'Grouped', type: 'grouped', sku: 'GRP', manage_stock: false, stock_quantity: null, backorders: 'no' },
    ];
    const variations = [
      { id: 31, sku: 'TEE-M', manage_stock: true, stock_quantity: 0, backorders: 'yes', attributes: [{ name: 'Size', option: 'M' }] },
      { id: 32, sku: 'TEE-L', manage_stock: true, stock_quantity: 4.9, backorders: 'no', attributes: [{ name: 'Size', option: 'L' }] },
    ];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(products))
      .mockResolvedValueOnce(jsonResponse(variations));
    const records = await fetchWooInventory(makeClient(fetchFn), 'woo-shop');

    // grouped product excluded; variable parent replaced by its variations.
    expect(records.map((r) => r.sku)).toEqual(['MUG-1', 'GIFT-1', 'TEE-M', 'TEE-L']);

    expect(records[0]).toMatchObject({ source: 'woo-shop', quantity: 7, quantityRaw: '7', tracked: true });
    expect(records[0]?.meta['inventoryPolicy']).toBe('deny');

    // manage_stock=false → quantity null + tracked=false (untracked rule input)
    expect(records[1]).toMatchObject({ quantity: null, quantityRaw: '', tracked: false });

    // backorders=yes → "continue" (oversell-risk continue-selling input)
    expect(records[2]).toMatchObject({ quantity: 0, tracked: true });
    expect(records[2]?.meta['inventoryPolicy']).toBe('continue');
    expect(records[2]?.title).toBe('Tee — M');

    // fractional stock truncated like the CSV adapters do
    expect(records[3]?.quantity).toBe(4);
  });
});
