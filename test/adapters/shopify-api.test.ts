import { diagnose } from '../../src/core/diagnose.js';
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
              pageInfo: { hasNextPage: false, endCursor: null },
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

  it('retries transient network errors like 429s', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(graphqlResponse({ data: { ok: true }, extensions: { cost: cost(900) } }));
    const client = makeClient(fetchFn, sleeps);
    const data = await client.graphql<{ ok: boolean }>('{ ok }');
    expect(data.ok).toBe(true);
    expect(sleeps).toEqual([1000]);
  });

  it('times out a hung request and reports the timeout clearly', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out', 'TimeoutError')),
          );
        }),
    );
    const client = new ShopifyClient({
      domain: 'a.myshopify.com',
      tokenProvider: new StaticTokenProvider('shpat_x'),
      fetchFn,
      sleep: (ms) => {
        sleeps.push(ms);
        return noSleep();
      },
      timeoutMs: 5,
      maxRetries: 1,
    });
    await expect(client.graphql('{ ok }')).rejects.toThrow(/timed out after 5ms/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
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


function levelsPage(hasNextPage: boolean, endCursor: string | null, empty = false) {
  const first = variantPage(['A'], false, null).data.productVariants.nodes[0]!;
  return { data: { inventoryItem: {
    id: first.inventoryItem.id,
    inventoryLevels: {
      nodes: empty ? [] : first.inventoryItem.inventoryLevels.nodes,
      pageInfo: { hasNextPage, endCursor },
    },
  } } };
}

function multiLocationFirst() {
  const first = variantPage(['A'], false, null);
  first.data.productVariants.nodes[0]!.inventoryItem.inventoryLevels.pageInfo = { hasNextPage: true, endCursor: 'level-1' };
  return first;
}

describe('Shopify snapshot completeness', () => {
  it('fetches all nested location pages with opaque cursors', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(graphqlResponse(multiLocationFirst()))
      .mockResolvedValueOnce(graphqlResponse(levelsPage(true, 'level-2')))
      .mockResolvedValueOnce(graphqlResponse(levelsPage(false, null)));
    const records = await fetchInventory(makeClient(fetchFn), 'store');
    expect(records).toHaveLength(3);
    expect(fetchFn.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)).variables)).toEqual([
      { itemId: 'gid://shopify/InventoryItem/0', cursor: 'level-1' },
      { itemId: 'gid://shopify/InventoryItem/0', cursor: 'level-2' },
    ]);
  });

  it.each([null, '', '   '])('rejects variant hasNextPage with cursor %j', async (cursor) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse(variantPage(['A'], true, cursor)));
    await expect(fetchInventory(makeClient(fetchFn), 'store')).rejects.toThrow(/nonempty cursor/);
  });

  it('rejects variant cursor cycles and empty continuation pages', async () => {
    for (const pages of [
      [variantPage(['A'], true, 'one'), variantPage(['B'], true, 'two'), variantPage(['C'], true, 'one')],
      [variantPage(['A'], true, 'one'), variantPage([], false, null)],
      [variantPage([], true, 'one')],
    ]) {
      const fetchFn = vi.fn<typeof fetch>();
      for (const page of pages) fetchFn.mockResolvedValueOnce(graphqlResponse(page));
      await expect(fetchInventory(makeClient(fetchFn), 'store')).rejects.toThrow(/repeated cursor|empty pagination page/);
    }
  });

  it.each([null, '', '   '])('rejects nested hasNextPage with cursor %j', async (cursor) => {
    const first = multiLocationFirst();
    Object.assign(first.data.productVariants.nodes[0]!.inventoryItem.inventoryLevels.pageInfo, { endCursor: cursor });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse(first));
    await expect(fetchInventory(makeClient(fetchFn), 'store')).rejects.toThrow(/nonempty cursor/);
  });

  it('rejects missing objects, empty nested pages, invalid nested cursors and cycles', async () => {
    for (const pages of [
      [{ data: { inventoryItem: null } }],
      [levelsPage(false, null, true)],
      [levelsPage(true, null)],
      [levelsPage(true, 'level-1')],
      [levelsPage(true, 'level-2'), levelsPage(true, 'level-1')],
    ]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(graphqlResponse(multiLocationFirst()));
      for (const page of pages) fetchFn.mockResolvedValueOnce(graphqlResponse(page));
      await expect(fetchInventory(makeClient(fetchFn), 'store')).rejects.toThrow(/Incomplete Shopify snapshot/);
    }
  });

  it('propagates later-page failures instead of returning accumulated records', async () => {
    for (const first of [variantPage(['A'], true, 'next'), multiLocationFirst()]) {
      const fetchFn = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(graphqlResponse(first))
        .mockResolvedValueOnce(graphqlResponse({ errors: [{ message: 'access denied' }] }));
      await expect(fetchInventory(makeClient(fetchFn), 'store')).rejects.toThrow(/access denied/);
    }
  });

  it('adapter → diagnose never flags API null quantities as blank CSV cells', async () => {
    const page = variantPage(['A', 'B'], false, null);
    page.data.productVariants.nodes[0]!.inventoryItem.inventoryLevels.nodes[0]!.quantities = [];
    page.data.productVariants.nodes[1]!.inventoryItem.inventoryLevels.nodes = [];
    Object.assign(page.data.productVariants.nodes[1]!, { inventoryQuantity: null });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(graphqlResponse(page));
    const records = await fetchInventory(makeClient(fetchFn), 'api');
    expect(records.map((r) => r.cellIsBlank)).toEqual([null, null]);
    expect(records.map((r) => r.quantity)).toEqual([null, null]);
    const zeroes = records.map((r) => ({ ...r, source: 'other-api', quantity: 0, quantityRaw: '0' }));
    expect(diagnose([...records, ...zeroes]).findings.filter((f) => f.rule === 'blank-vs-zero')).toEqual([]);
  });
});
