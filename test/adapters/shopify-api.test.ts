import { describe, expect, it, vi } from 'vitest';
import { API_VERSION, ShopifyClient } from '../../src/adapters/shopify-api/client.js';
import { StaticTokenProvider } from '../../src/adapters/shopify-api/token-provider.js';
import { fetchInventory } from '../../src/adapters/shopify-api/fetch-inventory.js';

const noSleep = () => Promise.resolve();

function graphqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function cost(currentlyAvailable: number, maximumAvailable = 1000, restoreRate = 50) {
  return {
    requestedQueryCost: 101,
    actualQueryCost: 46,
    throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate },
  };
}

function variantPage(skus: string[], hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      productVariants: {
        nodes: skus.map((sku, i) => ({
          sku,
          barcode: `B-${sku}`,
          title: `Title ${sku}`,
          inventoryQuantity: 10 + i,
          inventoryPolicy: 'DENY',
          inventoryItem: {
            id: `gid://shopify/InventoryItem/${i}`,
            tracked: true,
            inventoryLevels: {
              nodes: [
                {
                  location: { id: 'gid://shopify/Location/1', name: 'Main' },
                  quantities: [
                    { name: 'available', quantity: 10 + i },
                    { name: 'on_hand', quantity: 12 + i },
                    { name: 'committed', quantity: 2 },
                    { name: 'incoming', quantity: 0 },
                  ],
                },
              ],
            },
          },
        })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
    extensions: { cost: cost(954) },
  };
}

function makeClient(fetchFn: typeof fetch, sleeps: number[] = []): ShopifyClient {
  return new ShopifyClient({
    domain: 'a.myshopify.com',
    tokenProvider: new StaticTokenProvider('shpat_x'),
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return noSleep();
    },
  });
}

describe('ShopifyClient', () => {
  it('pins API version 2026-07 in the URL and sends the token header', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse({ data: {}, extensions: { cost: cost(954) } }));
    const client = makeClient(fetchFn);
    await client.graphql('{ shop { id } }');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://a.myshopify.com/admin/api/${API_VERSION}/graphql.json`);
    expect(API_VERSION).toBe('2026-07');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_x');
  });

  it('backs off 1s and retries on HTTP 429', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(graphqlResponse({ data: { ok: true }, extensions: { cost: cost(900) } }));
    const client = makeClient(fetchFn, sleeps);
    const data = await client.graphql<{ ok: boolean }>('{ ok }');
    expect(data.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it('backs off 1s and retries on THROTTLED GraphQL errors', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(graphqlResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }))
      .mockResolvedValueOnce(graphqlResponse({ data: { ok: true }, extensions: { cost: cost(900) } }));
    const client = makeClient(fetchFn, sleeps);
    await client.graphql('{ ok }');
    expect(sleeps).toEqual([1000]);
  });

  it('adaptively sleeps when throttleStatus says the bucket is nearly empty', async () => {
    const sleeps: number[] = [];
    // 40 of 1000 remaining (4% < 10%), restoreRate 50/s → wait ~1.2s.
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse({ data: { ok: true }, extensions: { cost: cost(40) } }));
    const client = makeClient(fetchFn, sleeps);
    await client.graphql('{ ok }');
    expect(sleeps).toEqual([Math.ceil(((100 - 40) / 50) * 1000)]);
  });

  it('does not sleep when the bucket is healthy', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse({ data: { ok: true }, extensions: { cost: cost(954) } }));
    await makeClient(fetchFn, sleeps).graphql('{ ok }');
    expect(sleeps).toEqual([]);
  });

  it('gives up after maxRetries instead of hanging forever', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('x', { status: 429 }));
    const client = makeClient(fetchFn);
    await expect(client.graphql('{ ok }')).rejects.toThrow(/429/);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('fetchInventory', () => {
  it('pages with opaque cursors and flattens levels to records', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(graphqlResponse(variantPage(['AAA', 'BBB'], true, 'cursor-2')))
      .mockResolvedValueOnce(graphqlResponse(variantPage(['CCC'], false, null)));
    const client = makeClient(fetchFn);
    const records = await fetchInventory(client, 'store-a');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Second call must reuse the opaque endCursor verbatim.
    const secondBody = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body)) as {
      variables: { cursor?: string };
    };
    expect(secondBody.variables.cursor).toBe('cursor-2');

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      source: 'store-a',
      sku: 'AAA',
      location: 'Main',
      quantity: 10,
      quantityRaw: '10',
      tracked: true,
    });
    expect(records[0]?.meta['on_hand']).toBe('12');
    expect(records[0]?.meta['committed']).toBe('2');
    expect(records[0]?.meta['inventoryPolicy']).toBe('deny');
  });

  it('sends the required quantities(names:) argument explicitly', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse(variantPage(['AAA'], false, null)));
    const client = makeClient(fetchFn);
    await fetchInventory(client, 'store-a');
    const body = String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body);
    expect(body).toContain('quantities(names: [\\"available\\", \\"on_hand\\", \\"committed\\", \\"incoming\\"])');
    expect(body).toContain('includeInactive: true');
  });
});
